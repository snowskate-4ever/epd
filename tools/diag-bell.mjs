#!/usr/bin/env node
"use strict";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(__dirname, "..", "captcha", "epd_captcha_collect_0001_1781257194272.jpg");
const OUT = path.join(__dirname, "..", "captcha", "out", "epd_captcha_collect_0001_1781257194272_bg.png");

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

const img = await Jimp.read(IMG);
const out = await Jimp.read(OUT);
const w = img.bitmap.width, h = 270, n = w * h;
const id = img.bitmap.data, od = out.bitmap.data;
const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), gray = new Float32Array(n);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x, o = i * 4;
  r[i] = id[o] / 255; g[i] = id[o + 1] / 255; b[i] = id[o + 2] / 255;
  gray[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
}
const edge = new Float32Array(n);
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  edge[i] = Math.hypot(gray[i + 1] - gray[i - 1], gray[i + w] - gray[i - w]);
}
const bgR = boxBlur(r, w, h, 32), bgG = boxBlur(g, w, h, 32), bgB = boxBlur(b, w, h, 32);
const coolTint = new Float32Array(n);
for (let i = 0; i < n; i++) coolTint[i] = clamp(((b[i] - bgB[i]) - (r[i] - bgR[i])) * 10, 0, 1);

const roi = [55, 155, 90, 90];
let stroke = 0, hit = 0, missGreen = 0, missBlue = 0;
for (let y = roi[1]; y < roi[1] + roi[3]; y++) for (let x = roi[0]; x < roi[0] + roi[2]; x++) {
  const i = y * w + x;
  const isStroke = edge[i] > 0.010 || coolTint[i] > 0.04;
  if (!isStroke) continue;
  stroke++;
  if (od[i * 4] < 200) hit++;
  else {
    const lh = rgbHue(bgR[i], bgG[i], bgB[i]);
    if (hueDist((id[i * 4] / 255), lh) < 0.06) missGreen++;
    else if (coolTint[i] > 0.04) missBlue++;
  }
}
console.log("bell/shower ROI", {
  stroke,
  hit,
  recall: ((hit / stroke) * 100).toFixed(1) + "%",
  missGreen,
  missBlue,
});
