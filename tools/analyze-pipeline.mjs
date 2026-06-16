#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp, rgbaToInt } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTCHA_DIR = path.join(__dirname, "..", "captcha");

// Inline mirror of bg-remove.js patchwork pipeline
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const hueDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };

function boxBlur(ch, w, h, r) {
  const rad = Math.max(1, r | 0), tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const diam = rad * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let sum = 0;
    for (let x = -rad; x <= rad; x++) sum += ch[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / diam;
      sum += ch[row + clamp(x + rad + 1, 0, w - 1)] - ch[row + clamp(x - rad, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -rad; y <= rad; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / diam;
      sum += tmp[clamp(y + rad + 1, 0, h - 1) * w + x] - tmp[clamp(y - rad, 0, h - 1) * w + x];
    }
  }
  return out;
}

function rgbHue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return 0;
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h / 6;
}

function rgbHueSat(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return { h: 0, s: 0 };
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s: d };
}

function fineEdge(g, w, h) {
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    e[i] = Math.hypot(g[i + 1] - g[i - 1], g[i + w] - g[i - w]);
  }
  return e;
}

function adaptiveThresh(score, n) {
  const vals = [];
  for (let i = 0; i < n; i++) if (score[i] > 0.02) vals.push(score[i]);
  if (!vals.length) return 0.2;
  vals.sort((a, b) => a - b);
  const p85 = vals[Math.floor(vals.length * 0.85)];
  const p50 = vals[Math.floor(vals.length * 0.50)];
  return clamp(Math.min(p85 * 0.50, p50 * 1.25), 0.04, 0.20);
}

function filterComponents(score, w, h, thresh) {
  const minArea = 35;
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = score[i] >= thresh ? 1 : 0;
  const fg = new Float32Array(w * h);
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  const dropped = [];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const shortSide = Math.min(bw, bh), longSide = Math.max(bw, bh);
    const aspect = longSide / Math.max(1, shortSide);
    const tiny = area < minArea;
    const longLine = aspect > 7 && shortSide < 14 && longSide > 35;
    if (tiny || longLine) { dropped.push({ area, bw, bh, minX, minY }); continue; }
    for (const pi of pixels) fg[pi] = 1;
  }
  return { fg: boxBlur(fg, w, h, 1), dropped };
}

function roiCount(fg, w, roi, thresh = 0.5) {
  let n = 0;
  for (let y = roi.y; y < roi.y + roi.h; y++)
    for (let x = roi.x; x < roi.x + roi.w; x++)
      if (fg[y * w + x] >= thresh) n++;
  return n;
}

function roiScoreAbove(score, w, roi, thresh) {
  let n = 0;
  for (let y = roi.y; y < roi.y + roi.h; y++)
    for (let x = roi.x; x < roi.x + roi.w; x++)
      if (score[y * w + x] >= thresh) n++;
  return n;
}

const ROIS = {
  heart: { x: 30, y: 20, w: 90, h: 80 },
  cloud: { x: 175, y: 55, w: 110, h: 70 },
  crown: { x: 300, y: 70, w: 80, h: 70 },
  fingerprint: { x: 380, y: 15, w: 90, h: 90 },
  bell: { x: 55, y: 155, w: 90, h: 90 },
  pink: { x: 380, y: 175, w: 80, h: 70 },
};

function splitMainH(data, w, h) {
  let top = h;
  for (let y = h - 1; y >= Math.max(0, h - 120); y--) {
    let dark = 0, n = 0;
    for (let x = 0; x < w; x += 4) {
      const o = (y * w + x) * 4;
      if (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114 < 40) dark++;
      n++;
    }
    if (n && dark / n > 0.75) { top = y; break; }
  }
  while (top > 0) {
    let dark = 0, n = 0;
    for (let x = 0; x < w; x += 4) {
      const o = ((top - 1) * w + x) * 4;
      if (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114 < 40) dark++;
      n++;
    }
    if (dark / n > 0.6) top--; else break;
  }
  return Math.max(1, top);
}

async function main() {
  const img = await Jimp.read(path.join(CAPTCHA_DIR, "epd_captcha_collect_0001_1781257194272.jpg"));
  const w = img.bitmap.width, fullH = img.bitmap.height;
  const mainH = splitMainH(img.bitmap.data, w, fullH);
  const data = img.bitmap.data;
  const n = w * mainH;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  const gray = new Float32Array(n), hue = new Float32Array(n), sat = new Float32Array(n);
  for (let y = 0; y < mainH; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = i * 4;
    r[i] = data[o] / 255; g[i] = data[o + 1] / 255; b[i] = data[o + 2] / 255;
    gray[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
    const hs = rgbHueSat(r[i], g[i], b[i]); hue[i] = hs.h; sat[i] = hs.s;
  }
  const edge = fineEdge(gray, w, mainH);
  const bgR = boxBlur(r, w, mainH, 32), bgG = boxBlur(g, w, mainH, 32), bgB = boxBlur(b, w, mainH, 32);
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dr = r[i] - bgR[i], dg = g[i] - bgG[i], db = b[i] - bgB[i];
    const colorDist = Math.hypot(dr, dg, db);
    const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
    const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
    const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
    const gate = Math.max(clamp((hueShift - 0.03) * 8, 0, 1), clamp(cool * 12, 0, 1), clamp(warm * 14, 0, 1));
    const distGate = clamp((colorDist - 0.01) * 9, 0, 1);
    score[i] = edge[i] * gate * (0.4 + 0.6 * distGate);
  }
  const dil = boxBlur(score, w, mainH, 1);
  for (let i = 0; i < n; i++) score[i] = Math.max(score[i], dil[i] * 0.85);
  const thresh = adaptiveThresh(score, n);
  console.log(`mainH=${mainH}, adaptive thresh=${thresh.toFixed(4)}\n`);

  const { fg, dropped } = filterComponents(score, w, mainH, thresh);
  console.log(`Dropped tiny components: ${dropped.filter(d => d.area < 35).length}`);
  const small = dropped.filter(d => d.area < 35).sort((a, b) => b.area - a.area).slice(0, 8);
  for (const d of small) console.log(`  area=${d.area} bbox=${d.bw}x${d.bh} at (${d.minX},${d.minY})`);

  console.log("\nROI pixels above thresh / in fg:");
  for (const [name, roi] of Object.entries(ROIS)) {
    const above = roiScoreAbove(score, w, roi, thresh);
    const kept = roiCount(fg, w, roi);
    console.log(`  ${name}: score>=thresh ${above}, fg ${kept}`);
  }

  // Sample pink region max score pixel
  const pink = ROIS.pink;
  let best = { s: 0, x: 0, y: 0 };
  for (let y = pink.y; y < pink.y + pink.h; y++) for (let x = pink.x; x < pink.x + pink.w; x++) {
    const i = y * w + x;
    if (score[i] > best.s) { best = { s: score[i], x, y }; }
  }
  const i = best.y * w + best.x, o = i * 4;
  console.log(`\nPink ROI max score ${best.s.toFixed(4)} at (${best.x},${best.y})`);
  console.log(`  RGB ${data[o]},${data[o+1]},${data[o+2]} sat=${sat[i].toFixed(3)} hue=${hue[i].toFixed(3)} edge=${edge[i].toFixed(4)}`);
}

main().catch(console.error);
