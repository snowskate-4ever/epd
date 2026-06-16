#!/usr/bin/env node
"use strict";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(__dirname, "..", "captcha", "epd_captcha_collect_0001_1781257194272.jpg");

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const hueDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };

function boxBlur(ch, w, h, r) {
  const rad = Math.max(1, r | 0), tmp = new Float32Array(w * h), out = new Float32Array(w * h), diam = rad * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let sum = 0;
    for (let x = -rad; x <= rad; x++) sum += ch[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) { tmp[row + x] = sum / diam; sum += ch[row + clamp(x + rad + 1, 0, w - 1)] - ch[row + clamp(x - rad, 0, w - 1)]; }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -rad; y <= rad; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = sum / diam; sum += tmp[clamp(y + rad + 1, 0, h - 1) * w + x] - tmp[clamp(y - rad, 0, h - 1) * w + x]; }
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

function scorePatchwork(r, g, b, hue, edge, bgR, bgG, bgB, i) {
  const dr = r[i] - bgR[i], dg = g[i] - bgG[i], db = b[i] - bgB[i];
  const colorDist = Math.hypot(dr, dg, db);
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
  const gate = Math.max(clamp((hueShift - 0.03) * 8, 0, 1), clamp(cool * 12, 0, 1), clamp(warm * 14, 0, 1));
  const distGate = clamp((colorDist - 0.01) * 9, 0, 1);
  return edge[i] * gate * (0.4 + 0.6 * distGate);
}

function ccBlobs(bin, w, h) {
  const seen = new Int32Array(w * h);
  const blobs = [];
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
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
    blobs.push({ area: pixels.length, pixels, minX, maxX, minY, maxY,
      cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 });
  }
  return blobs;
}

function centroidDist(a, b) {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

const img = await Jimp.read(IMG);
const w = img.bitmap.width, h = 210, data = img.bitmap.data, n = w * h;
const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
const gray = new Float32Array(n), hue = new Float32Array(n), sat = new Float32Array(n);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x, o = i * 4;
  r[i] = data[o] / 255; g[i] = data[o + 1] / 255; b[i] = data[o + 2] / 255;
  gray[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
  const hs = rgbHueSat(r[i], g[i], b[i]); hue[i] = hs.h; sat[i] = hs.s;
}
const edge = new Float32Array(n);
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  edge[i] = Math.hypot(gray[i + 1] - gray[i - 1], gray[i + w] - gray[i - w]);
}
const bgR = boxBlur(r, w, h, 32), bgG = boxBlur(g, w, h, 32), bgB = boxBlur(b, w, h, 32);
const score = new Float32Array(n);
for (let i = 0; i < n; i++) score[i] = scorePatchwork(r, g, b, hue, edge, bgR, bgG, bgB, i);
const dil = boxBlur(score, w, h, 1);
for (let i = 0; i < n; i++) score[i] = Math.max(score[i], dil[i] * 0.85);
const vals = [];
for (let i = 0; i < n; i++) if (score[i] > 0.02) vals.push(score[i]);
vals.sort((a, b) => a - b);
const thresh = clamp(Math.min(vals[Math.floor(vals.length * 0.85)] * 0.5, vals[Math.floor(vals.length * 0.5)] * 1.25), 0.04, 0.2);

const bin = new Uint8Array(n);
for (let i = 0; i < n; i++) bin[i] = score[i] >= thresh ? 1 : 0;
const blobs = ccBlobs(bin, w, h);
const kept = blobs.filter(b => b.area >= 35 && !(b.area > 9000));
const dropped = blobs.filter(b => b.area >= 8 && b.area < 35);

const ROIS = {
  bell: [55, 155, 90, 90],
  cloud: [175, 55, 110, 70],
  pink: [385, 175, 70, 35],
};

function inRoi(b, roi) {
  return b.cx >= roi[0] && b.cx < roi[0] + roi[2] && b.cy >= roi[1] && b.cy < roi[1] + roi[3];
}

for (const [name, roi] of Object.entries(ROIS)) {
  const k = kept.filter(b => inRoi(b, roi));
  const d = dropped.filter(b => inRoi(b, roi));
  console.log(`\n${name}: kept=${k.length} dropped=${d.length}`);
  for (const bl of k) console.log(`  KEPT area=${bl.area} bbox=${bl.maxX-bl.minX+1}x${bl.maxY-bl.minY+1}`);
  for (const bl of d) {
    let minD = Infinity;
    for (const kb of k) minD = Math.min(minD, centroidDist(bl, kb));
    console.log(`  DROP area=${bl.area} dist=${minD.toFixed(1)}`);
  }
}

// pink camo coverage
const satRing = boxBlur(sat, w, h, 3), grayRing = boxBlur(gray, w, h, 3);
let pinkCamo = 0, pinkTh = [0.1,0.15,0.18,0.22,0.28];
for (const th of pinkTh) {
  let c = 0;
  const roi = ROIS.pink;
  for (let y = roi[1]; y < roi[1] + roi[3]; y++) for (let x = roi[0]; x < roi[0] + roi[2]; x++) {
    const i = y * w + x;
    const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
    const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
    const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
    const gate = Math.max(clamp((hueShift - 0.03) * 8, 0, 1), clamp(cool * 12, 0, 1), clamp(warm * 14, 0, 1));
    if (gate >= 0.25) continue;
    const satRes = Math.max(0, sat[i] - satRing[i]);
    const lumRes = Math.abs(gray[i] - grayRing[i]);
    const edgeSat = 0;
    const sig = Math.max(satRes * 60, lumRes * 15);
    const camo = Math.max(edge[i], 0) * sig * clamp((0.08 - hueShift) * 20, 0, 1);
    if (camo >= th) c++;
  }
  console.log(`pink camo>=${th}: ${c}px`);
}
