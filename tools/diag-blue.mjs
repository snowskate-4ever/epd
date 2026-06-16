#!/usr/bin/env node
"use strict";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(__dirname, "..", "captcha", "epd_captcha_collect_0001_1781257441064.jpg");
const OUT = path.join(__dirname, "..", "captcha", "out", "epd_captcha_collect_0001_1781257441064_bg.png");

const img = await Jimp.read(IMG);
const out = await Jimp.read(OUT);
const w = img.bitmap.width, h = 270;
const id = img.bitmap.data, od = out.bitmap.data, n = w * h;
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

const rois = {
  fingerprint: [40, 140, 120, 100],
  key: [180, 90, 120, 100],
  padlock: [180, 20, 120, 80],
  bug: [300, 140, 120, 100],
};

for (const [name, roi] of Object.entries(rois)) {
  let dark = 0, miss = 0, stroke = 0;
  for (let y = roi[1]; y < roi[1] + roi[3]; y++) for (let x = roi[0]; x < roi[0] + roi[2]; x++) {
    const i = y * w + x;
    const cool = (b[i] - 0.55) - (r[i] - 0.55);
    const isStroke = edge[i] > 0.012 || cool > 0.04;
    if (!isStroke) continue;
    stroke++;
    if (od[i * 4] < 200) dark++;
    else miss++;
  }
  console.log(name, { dark, stroke, miss, pct: ((dark / stroke) * 100).toFixed(0) + "%" });
}

// upper camo zone overlap
const fieldH = 218;
const zx0 = Math.floor(w * 0.62), zy0 = Math.floor(fieldH * 0.15), zy1 = Math.floor(fieldH * 0.58);
let inZone = 0, wiped = 0;
for (let y = zy0; y < zy1; y++) for (let x = zx0; x < w; x++) {
  const i = y * w + x;
  const cool = (b[i] - 0.55) - (r[i] - 0.55);
  if (edge[i] > 0.012 && cool > 0.03) {
    inZone++;
    if (od[i * 4] >= 200) wiped++;
  }
}
console.log("upper zone missed blue strokes", wiped, "/", inZone);
