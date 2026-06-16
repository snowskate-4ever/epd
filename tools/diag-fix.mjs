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

const ROIS = {
  pink: [385, 175, 70, 35], bell: [55, 155, 90, 90], cloud: [175, 55, 110, 70],
  heart: [30, 20, 90, 80],
};

function roiMax(fn, w, roi) {
  let m = 0;
  for (let y = roi[1]; y < roi[1] + roi[3]; y++)
    for (let x = roi[0]; x < roi[0] + roi[2]; x++) m = Math.max(m, fn(y * w + x));
  return m;
}

function roiCount(fn, w, roi, th) {
  let c = 0;
  for (let y = roi[1]; y < roi[1] + roi[3]; y++)
    for (let x = roi[0]; x < roi[0] + roi[2]; x++) if (fn(y * w + x) >= th) c++;
  return c;
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
const edge = new Float32Array(n), edgeSat = new Float32Array(n);
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  edge[i] = Math.hypot(gray[i + 1] - gray[i - 1], gray[i + w] - gray[i - w]);
  edgeSat[i] = Math.hypot(sat[i + 1] - sat[i - 1], sat[i + w] - sat[i - w]);
}
const satRing = boxBlur(sat, w, h, 3), grayRing = boxBlur(gray, w, h, 3);
const satRes = new Float32Array(n), lumRes = new Float32Array(n);
for (let i = 0; i < n; i++) { satRes[i] = Math.max(0, sat[i] - satRing[i]); lumRes[i] = Math.abs(gray[i] - grayRing[i]); }
const bgR = boxBlur(r, w, h, 32), bgG = boxBlur(g, w, h, 32), bgB = boxBlur(b, w, h, 32);

function oldCamo(i) {
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  if (clamp((hueShift - 0.03) * 8, 0, 1) > 0.2 || clamp(cool * 12, 0, 1) > 0.35 || hueShift > 0.07 || sat[i] < 0.21) return 0;
  if (edgeSat[i] < 0.012 && edge[i] < 0.015) return 0;
  return Math.max(edgeSat[i] * 3, edge[i] * 0.6) * sat[i] * clamp((0.08 - hueShift) * 20, 0, 1) * 6;
}

function newCamo(i) {
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
  const gate = Math.max(clamp((hueShift - 0.03) * 8, 0, 1), clamp(cool * 12, 0, 1), clamp(warm * 14, 0, 1));
  if (gate >= 0.25 || hueShift > 0.075 || sat[i] < 0.19) return 0;
  const sig = Math.max(satRes[i] * 60, edgeSat[i] * 8, lumRes[i] * 15);
  if (sig < 0.08) return 0;
  return Math.max(edge[i], edgeSat[i] * 2.2) * sig * clamp((0.08 - hueShift) * 20, 0, 1);
}

for (const [name, roi] of Object.entries(ROIS)) {
  console.log(name, {
    oldMax: roiMax(oldCamo, w, roi).toFixed(3),
    newMax: roiMax(newCamo, w, roi).toFixed(3),
    newAbove02: roiCount(newCamo, w, roi, 0.2),
    newAbove05: roiCount(newCamo, w, roi, 0.5),
  });
}
