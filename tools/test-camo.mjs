#!/usr/bin/env node
"use strict";
import { Jimp, rgbaToInt } from "jimp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

function mainGate(hue, sat, r, g, b, bgR, bgG, bgB, i) {
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
  return {
    gate: Math.max(clamp((hueShift - 0.03) * 8, 0, 1), clamp(cool * 12, 0, 1), clamp(warm * 14, 0, 1)),
    hueShift,
  };
}

function scorePatchwork(r, g, b, hue, edge, bgR, bgG, bgB, i) {
  const dr = r[i] - bgR[i], dg = g[i] - bgG[i], db = b[i] - bgB[i];
  const colorDist = Math.hypot(dr, dg, db);
  const { gate, hueShift } = mainGate(hue, null, r, g, b, bgR, bgG, bgB, i);
  const distGate = clamp((colorDist - 0.01) * 9, 0, 1);
  return edge[i] * gate * (0.4 + 0.6 * distGate);
}

function camouflageScore(r, g, b, hue, sat, gray, edge, edgeSat, satRes, grayRes, bgR, bgG, bgB, i) {
  const { gate, hueShift } = mainGate(hue, sat, r, g, b, bgR, bgG, bgB, i);
  if (gate >= 0.22 || hueShift > 0.08 || sat[i] < 0.19) return 0;
  const sig = Math.max(satRes[i] * 55, edgeSat[i] * 7, grayRes[i] * 12);
  if (sig < 0.06) return 0;
  const e = Math.max(edge[i], edgeSat[i] * 2.2);
  return e * sig * clamp((0.085 - hueShift) * 18, 0, 1);
}

function roiMax(fn, w, rx, ry, rw, rh) {
  let m = 0;
  for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) m = Math.max(m, fn(y * w + x));
  return m;
}

const img = await Jimp.read(path.join(__dirname, "..", "captcha", "epd_captcha_collect_0001_1781257194272.jpg"));
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
const bgR = boxBlur(r, w, h, 32), bgG = boxBlur(g, w, h, 32), bgB = boxBlur(b, w, h, 32);
const satBlur = boxBlur(sat, w, h, 3), grayBlur = boxBlur(gray, w, h, 3);
const satRes = new Float32Array(n), grayRes = new Float32Array(n);
for (let i = 0; i < n; i++) {
  satRes[i] = Math.max(0, sat[i] - satBlur[i]);
  grayRes[i] = Math.abs(gray[i] - grayBlur[i]);
}

const base = (i) => scorePatchwork(r, g, b, hue, edge, bgR, bgG, bgB, i);
const camo = (i) => camouflageScore(r, g, b, hue, sat, gray, edge, edgeSat, satRes, grayRes, bgR, bgG, bgB, i);
const combined = (i) => Math.max(base(i), camo(i));

console.log("camo only:", {
  pink: roiMax(camo, w, 385, 175, 70, 35),
  heart: roiMax(camo, w, 30, 20, 90, 80),
  crown: roiMax(camo, w, 300, 70, 80, 70),
});
console.log("combined pink px >= 0.012:", (() => {
  let c = 0;
  for (let y = 175; y < 210; y++) for (let x = 385; x < 455; x++) if (combined(y * w + x) >= 0.012) c++;
  return c;
})());

// full pipeline quick
const score = new Float32Array(n);
for (let i = 0; i < n; i++) score[i] = combined(i);
const dil = boxBlur(score, w, h, 1);
for (let i = 0; i < n; i++) score[i] = Math.max(score[i], dil[i] * 0.85);
const vals = [];
for (let i = 0; i < n; i++) if (score[i] > 0.02) vals.push(score[i]);
vals.sort((a, b) => a - b);
const thresh = clamp(Math.min(vals[Math.floor(vals.length * 0.85)] * 0.5, vals[Math.floor(vals.length * 0.5)] * 1.25), 0.04, 0.2);

let dark = 0, pinkFg = 0;
const out = new Jimp({ width: w, height: h, color: 0xffffffff });
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x;
  const v = score[i] >= thresh ? 0 : 255;
  if (v < 200) dark++;
  if (v < 200 && x >= 385 && x < 455 && y >= 175 && y < 210) pinkFg++;
  out.setPixelColor(rgbaToInt(v, v, v, 255), x, y);
}
fs.mkdirSync(path.join(__dirname, "..", "captcha", "out"), { recursive: true });
await out.write(path.join(__dirname, "..", "captcha", "out", "test_camo.png"));
console.log({ thresh, dark, pinkFg });
