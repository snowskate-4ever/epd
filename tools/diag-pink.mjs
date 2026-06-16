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

function rgbHueSat(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return { h: 0, s: 0 };
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s: d };
}

function camoScore(r, g, b, hue, sat, edge, edgeSat, satRes, lumRes, bgR, bgG, bgB, i) {
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
  const gate = Math.max(clamp((hueShift - 0.03) * 8, 0, 1), clamp(cool * 12, 0, 1), clamp(warm * 14, 0, 1));
  if (gate >= 0.25 || hueShift > 0.075 || sat[i] < 0.19) return { camo: 0, gate, hueShift, warm, sig: 0 };
  let sig = Math.max(satRes[i] * 60, edgeSat[i] * 8, lumRes[i] * 15);
  const warmPink = warm > 0.008 && (hue[i] > 0.68 || hue[i] < 0.1);
  if (warmPink) sig = Math.max(sig * 1.45, 0.09);
  if (sig < 0.08) return { camo: 0, gate, hueShift, warm, sig };
  const camo = Math.max(edge[i], edgeSat[i] * 2.4) * sig * clamp((0.085 - hueShift) * 20, 0, 1);
  return { camo, gate, hueShift, warm, sig };
}

const img = await Jimp.read(IMG);
const out = await Jimp.read(OUT);
const w = img.bitmap.width, h = 210, id = img.bitmap.data, od = out.bitmap.data, n = w * h;
const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
const gray = new Float32Array(n), hue = new Float32Array(n), sat = new Float32Array(n);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x, o = i * 4;
  r[i] = id[o] / 255; g[i] = id[o + 1] / 255; b[i] = id[o + 2] / 255;
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
const bgR = boxBlur(r, w, h, 32), bgG = boxBlur(g, w, h, 32), bgB = boxBlur(b, w, h, 32);
const satRes = new Float32Array(n), lumRes = new Float32Array(n);
for (let i = 0; i < n; i++) {
  satRes[i] = Math.max(0, sat[i] - satRing[i]);
  lumRes[i] = Math.abs(gray[i] - grayRing[i]);
}

// pink icon approximate region on green/yellow tile
const roi = { x0: 400, y0: 165, x1: 470, y1: 210 };
let have = 0, missCamo = [], missLow = [], missGate = [];
for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
  const i = y * w + x;
  const dark = od[i * 4] < 200;
  if (dark) { have++; continue; }
  // stroke candidate: local sat edge or visible pink tint in original
  const origPink = sat[i] > 0.12 && (hue[i] > 0.75 || hue[i] < 0.08 || (r[i] - g[i]) > 0.05);
  const stroke = edgeSat[i] > 0.006 || edge[i] > 0.008;
  if (!stroke && !origPink) continue;
  const s = camoScore(r, g, b, hue, sat, edge, edgeSat, satRes, lumRes, bgR, bgG, bgB, i);
  if (s.gate >= 0.25) missGate.push({ x, y, ...s });
  else if (s.camo < 0.028) missLow.push({ x, y, ...s, edgeSat: edgeSat[i], edge: edge[i] });
  else missCamo.push({ x, y, ...s });
}
console.log("have", have);
console.log("miss with camo>=0.028", missCamo.length, missCamo.slice(0, 5));
console.log("miss low camo", missLow.length);
console.log("miss gate block", missGate.length, missGate.slice(0, 5));

// count potential at lower thresholds in expanded roi
const counts = {};
for (const th of [0.02, 0.025, 0.028, 0.032, 0.04, 0.05]) {
  let c = 0;
  for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
    const i = y * w + x;
    if (camoScore(r, g, b, hue, sat, edge, edgeSat, satRes, lumRes, bgR, bgG, bgB, i).camo >= th) c++;
  }
  counts[th] = c;
}
console.log("camo counts in roi", counts);

// sample worst missLow
missLow.sort((a, b) => b.edgeSat - a.edgeSat);
console.log("top missLow", missLow.slice(0, 8));
