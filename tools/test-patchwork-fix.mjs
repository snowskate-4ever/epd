#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp, rgbaToInt } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTCHA_DIR = path.join(__dirname, "..", "captcha");
const OUT_DIR = path.join(CAPTCHA_DIR, "out");

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

function localStdDev(ch, w, h, r) {
  const mean = boxBlur(ch, w, h, r);
  const sq = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) sq[i] = ch[i] * ch[i];
  const meanSq = boxBlur(sq, w, h, r);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { const v = meanSq[i] - mean[i] ** 2; out[i] = v > 0 ? Math.sqrt(v) : 0; }
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

function detectStyle(hue, sat, edge, gray, w, h) {
  const n = w * h;
  const stdS = localStdDev(gray, w, h, 3);
  let green = 0, texture = 0, avgSat = 0;
  for (let i = 0; i < n; i++) {
    avgSat += sat[i];
    if (hueDist(hue[i], 0.28) < 0.16 && sat[i] < 0.34) green++;
    if (sat[i] > 0.20 && stdS[i] > 0.035) texture++;
  }
  avgSat /= n;
  if (green / n > 0.30) return "patchwork";
  if (avgSat > 0.32) return "gradient";
  if (texture / n > 0.06 && avgSat > 0.10) return "pattern";
  return "gradient";
}

function scorePatchwork(r, g, b, hue, sat, gray, edge, bgR, bgG, bgB, bgGrayFine, i) {
  const dr = r - bgR[i], dg = g - bgG[i], db = b - bgB[i];
  const colorDist = Math.hypot(dr, dg, db);
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b - bgB[i]) - (r - bgR[i]);
  const warm = (r - bgR[i]) - (g - bgG[i]);
  const chromaGate = clamp((hueShift - 0.03) * 8, 0, 1);
  const coolGate = clamp(cool * 12, 0, 1);
  const warmGate = clamp(warm * 14, 0, 1);
  const magenta = dr + db - 1.4 * dg;
  const magentaGate = clamp(magenta * 9, 0, 1);
  const distGate = clamp((colorDist - 0.01) * 9, 0, 1);
  const lumDeltaFine = gray[i] - bgGrayFine[i];
  const paleGate = sat[i] > 0.14 && lumDeltaFine > 0.006 && edge[i] > 0.012
    ? clamp((sat[i] - 0.11) * 3.2, 0, 1) * clamp((lumDeltaFine - 0.004) * 16, 0, 1)
    : 0;
  const gate = Math.max(chromaGate, coolGate, warmGate, magentaGate);
  const distWeight = cool > 0.015 ? (0.52 + 0.48 * distGate) : (0.4 + 0.6 * distGate);
  const base = edge[i] * gate * distWeight;
  const pale = gate < 0.12 && sat[i] > 0.18 && paleGate > 0.08 ? edge[i] * paleGate * 4.2 : 0;
  return Math.max(base, pale);
}

function closePatchworkScore(score, w, h, thresh) {
  const weak = thresh * 0.62;
  const bin = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = score[i] >= weak ? 1 : 0;
  const closed = boxBlur(bin, w, h, 1);
  for (let i = 0; i < w * h; i++) {
    if (closed[i] > 0.52 && score[i] >= weak * 0.9) score[i] = Math.max(score[i], thresh * 0.86);
  }
}

function bridgePatchworkFg(fg, score, w, h, thresh) {
  const low = thresh * 0.58;
  const dil = boxBlur(fg, w, h, 2);
  for (let i = 0; i < w * h; i++) {
    if (dil[i] > 0.38 && score[i] >= low) fg[i] = Math.max(fg[i], 0.88);
  }
}

function rescuePaleSeeds(score, fg, sat, gray, edge, bgGrayFine, w, h) {
  const paleScore = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const lumDeltaFine = gray[i] - bgGrayFine[i];
    const paleGate = sat[i] > 0.14 && lumDeltaFine > 0.006 && edge[i] > 0.012
      ? clamp((sat[i] - 0.11) * 3.2, 0, 1) * clamp((lumDeltaFine - 0.004) * 16, 0, 1) : 0;
    paleScore[i] = edge[i] * paleGate * 4.2;
  }
  const seeds = [];
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    if (paleScore[i] < 0.032 || sat[i] < 0.20) continue;
    let isMax = true;
    for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (paleScore[(y + dy) * w + (x + dx)] > paleScore[i] + 0.001) { isMax = false; break; }
    }
    if (isMax) seeds.push(i);
  }
  const seen = new Uint8Array(w * h);
  const dx = [1, -1, 0, 0], dy = [0, 0, 1, -1];
  const candidates = [];
  for (const seed of seeds) {
    const sy = (seed / w) | 0, sx = seed - sy * w;
    const q = [seed]; seen[seed] = 1; const pixels = [];
    while (q.length) {
      const ci = q.pop();
      const cy = (ci / w) | 0, cx = ci - cy * w;
      if (Math.abs(cx - sx) > 14 || Math.abs(cy - sy) > 14) continue;
      pixels.push(ci);
      for (let d = 0; d < 4; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni] || paleScore[ni] < 0.009 || sat[ni] < 0.14 || edge[ni] < 0.008) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    if (pixels.length < 6 || pixels.length > 42) continue;
    let minX = sx, maxX = sx, minY = sy, maxY = sy, paleSum = 0;
    for (const pi of pixels) {
      const py = (pi / w) | 0, px = pi - py * w;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      paleSum += paleScore[pi];
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const shortSide = Math.min(bw, bh), longSide = Math.max(bw, bh);
    const aspect = longSide / Math.max(1, shortSide);
    const avgPale = paleSum / pixels.length;
    if (avgPale < 0.022) continue;
    const thinPaleIcon = pixels.length <= 35 && avgPale > 0.038 && avgPale < 0.085
      && shortSide >= 2 && longSide <= 32;
    if (!thinPaleIcon && (shortSide < 3 || longSide > 40 || aspect > 5)) continue;
    if (!thinPaleIcon && pixels.length / (bw * bh) > 0.82) continue;
    let fgOverlap = 0;
    for (const pi of pixels) if (fg[pi] > 0.35) fgOverlap++;
    if (fgOverlap / pixels.length > 0.25) continue;
    candidates.push({ pixels, avgPale });
  }
  candidates.sort((a, b) => b.avgPale - a.avgPale);
  for (const cand of candidates) {
    for (const pi of cand.pixels) fg[pi] = Math.max(fg[pi], 0.92);
  }
}

function suppressPatchworkLines(fg, edge, tint, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = edge[i] > 0.018 && tint[i] < 0.12 ? 1 : 0;
  const minLen = 28;
  const zeroH = () => {
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) { run++; if (run >= minLen) for (let k = x - run + 1; k <= x; k++) fg[y * w + k] = 0; }
        else run = 0;
      }
    }
  };
  const zeroV = () => {
    for (let x = 0; x < w; x++) {
      let run = 0;
      for (let y = 0; y < h; y++) {
        if (mask[y * w + x]) { run++; if (run >= minLen) for (let k = y - run + 1; k <= y; k++) fg[k * w + x] = 0; }
        else run = 0;
      }
    }
  };
  zeroH(); zeroV();
}

function filterComponents(score, w, h, thresh, style) {
  const minArea = style === "pattern" ? 120 : style === "gradient" ? 70 : 26;
  const maxArea = style === "pattern" ? 2800 : 9000;
  const conn8 = style !== "pattern";
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = score[i] >= thresh ? 1 : 0;
  const fg = new Float32Array(w * h);
  const seen = new Int32Array(w * h);
  const dx = conn8 ? [1, -1, 0, 0, 1, 1, -1, -1] : [1, -1, 0, 0];
  const dy = conn8 ? [0, 0, 1, -1, 1, -1, 1, -1] : [0, 0, 1, -1];
  const dirs = dx.length;
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
      for (let d = 0; d < dirs; d++) {
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
    if (area < minArea || area > maxArea || (aspect > 7 && shortSide < 14 && longSide > 35) || (area > 250 && area / (longSide * 2) > 12)) continue;
    for (const pi of pixels) fg[pi] = 1;
  }
  return boxBlur(fg, w, h, 1);
}

function adaptiveThresh(score, n, style) {
  const vals = [];
  for (let i = 0; i < n; i++) if (score[i] > 0.02) vals.push(score[i]);
  if (!vals.length) return 0.2;
  vals.sort((a, b) => a - b);
  const p85 = vals[Math.floor(vals.length * 0.85)];
  const p50 = vals[Math.floor(vals.length * 0.50)];
  return clamp(Math.min(p85 * 0.50, p50 * 1.25), 0.04, style === "gradient" ? 0.16 : 0.20);
}

function computeFg(data, w, mainH) {
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
  const style = detectStyle(hue, sat, edge, gray, w, mainH);
  const score = new Float32Array(n);
  if (style === "patchwork") {
    const bgR = boxBlur(r, w, mainH, 32), bgG = boxBlur(g, w, mainH, 32), bgB = boxBlur(b, w, mainH, 32);
    const bgGrayFine = boxBlur(gray, w, mainH, 8);
    const tint = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      score[i] = scorePatchwork(r[i], g[i], b[i], hue, sat, gray, edge, bgR, bgG, bgB, bgGrayFine, i);
      const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
      tint[i] = Math.max(clamp(((b[i] - bgB[i]) - (r[i] - bgR[i])) * 10, 0, 1), clamp(warm * 10, 0, 1));
    }
    const dil = boxBlur(score, w, mainH, 1);
    for (let i = 0; i < n; i++) score[i] = Math.max(score[i], dil[i] * 0.85);
    const thresh = adaptiveThresh(score, n, style);
    closePatchworkScore(score, w, mainH, thresh);
    let fg = filterComponents(score, w, mainH, thresh, style);
    bridgePatchworkFg(fg, score, w, mainH, thresh);
    rescuePaleSeeds(score, fg, sat, gray, edge, bgGrayFine, w, mainH);
    suppressPatchworkLines(fg, edge, tint, w, mainH);
    const fg2 = boxBlur(fg, w, mainH, 1);
    for (let i = 0; i < n; i++) fg[i] = Math.max(fg[i], fg2[i] * 0.75);
    return { fg, style, thresh };
  }
  return { fg: new Float32Array(n), style, thresh: 0 };
}

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

const ROIS = {
  heart: { x: 30, y: 20, w: 90, h: 80 },
  cloud: { x: 175, y: 55, w: 110, h: 70 },
  crown: { x: 300, y: 70, w: 80, h: 70 },
  fingerprint: { x: 380, y: 15, w: 90, h: 90 },
  bell: { x: 55, y: 155, w: 90, h: 90 },
  pink: { x: 380, y: 175, w: 80, h: 70 },
};

function roiCount(fg, w, roi) {
  let n = 0;
  for (let y = roi.y; y < roi.y + roi.h; y++)
    for (let x = roi.x; x < roi.x + roi.w; x++)
      if (fg[y * w + x] >= 0.5) n++;
  return n;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = "epd_captcha_collect_0001_1781257194272.jpg";
  const img = await Jimp.read(path.join(CAPTCHA_DIR, file));
  const w = img.bitmap.width, h = img.bitmap.height, data = img.bitmap.data;
  const mainH = splitMainH(data, w, h);
  const { fg, style, thresh } = computeFg(data, w, mainH);
  const out = new Jimp({ width: w, height: mainH, color: 0xffffffff });
  let darkPx = 0;
  for (let y = 0; y < mainH; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const v = Math.round(255 * (1 - clamp(fg[i], 0, 1)));
    if (v < 200) darkPx++;
    out.setPixelColor(rgbaToInt(v, v, v, 255), x, y);
  }
  const base = file.replace(/\.jpe?g$/i, "");
  await out.write(path.join(OUT_DIR, `${base}_bg.png`));
  console.log({ style, thresh, darkPx });
  for (const [name, roi] of Object.entries(ROIS)) {
    console.log(`  ${name}: ${roiCount(fg, w, roi)} fg px`);
  }
}

main().catch(console.error);
