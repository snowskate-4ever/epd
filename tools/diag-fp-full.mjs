#!/usr/bin/env node
"use strict";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(__dirname, "..", "captcha", "epd_captcha_collect_0001_1781257194272.jpg");
const OUT = path.join(__dirname, "..", "captcha", "out", "epd_captcha_collect_0001_1781257194272_bg.png");

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

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

function buildSatEdge(sat, w, h) {
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    e[i] = Math.hypot(sat[i + 1] - sat[i - 1], sat[i + w] - sat[i - w]);
  }
  return e;
}

const fieldH = 218;
const fp = (x, y, w) => x >= w * 0.80 && y >= fieldH * 0.08 && y < fieldH * 0.60;

const img = await Jimp.read(IMG);
const out = await Jimp.read(OUT);
const w = img.bitmap.width, mainH = 270, n = w * mainH;
const gray = new Float32Array(n), coolTint = new Float32Array(n), edge = new Float32Array(n), sat = new Float32Array(n);
for (let y = 0; y < mainH; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x, o = i * 4;
  const r = img.bitmap.data[o] / 255, g = img.bitmap.data[o + 1] / 255, b = img.bitmap.data[o + 2] / 255;
  gray[i] = r * 0.299 + g * 0.587 + b * 0.114;
  coolTint[i] = clamp(((b - r) - (r - r)) * 10, 0, 1);
  sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
}
const bgR = boxBlur(new Float32Array(n), w, mainH, 32);
for (let i = 0; i < n; i++) {
  const o = i * 4;
  const r = img.bitmap.data[o] / 255, b = img.bitmap.data[o + 2] / 255;
  coolTint[i] = clamp((b - bgR[i]) - (r - bgR[i]), 0, 1) * 10;
  coolTint[i] = clamp(coolTint[i], 0, 1);
}
for (let y = 1; y < mainH - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  edge[i] = Math.hypot(gray[i + 1] - gray[i - 1], gray[i + mainH] - gray[i - mainH]);
}
const edgeSat = buildSatEdge(sat, w, mainH);

let px = 0, stroke = 0, hit = 0;
for (let y = 15; y < 120; y++) for (let x = 380; x < 470; x++) {
  if (!fp(x, y, w)) continue;
  const i = y * w + x;
  if (out.bitmap.data[i * 4] < 128) px++;
  const isStroke = edge[i] > 0.010 || coolTint[i] > 0.04 || edgeSat[i] > 0.008;
  if (!isStroke) continue;
  stroke++;
  if (out.bitmap.data[i * 4] < 128) hit++;
}
console.log({ px, stroke, recall: ((hit / stroke) * 100).toFixed(1) + "%" });
