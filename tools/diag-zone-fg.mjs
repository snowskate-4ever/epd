#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(ROOT, "bg-remove.js"), "utf8");
class ImageData { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } }
const document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {} }) }) };
const sandbox = { console, Math, Float32Array, Uint8Array, Uint8ClampedArray, Int32Array, Array, Object, ImageData, document, window: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const img = await Jimp.read(path.join(ROOT, "captcha", "epd_captcha_collect_0001_1781257194272.jpg"));
const w = img.bitmap.width;
let h = img.bitmap.height;
for (let y = h - 1; y >= h - 120; y--) {
  let dark = 0, n = 0;
  for (let x = 0; x < w; x += 4) {
    const o = (y * w + x) * 4;
    if (img.bitmap.data[o] * 0.299 + img.bitmap.data[o + 1] * 0.587 + img.bitmap.data[o + 2] * 0.114 < 40) dark++;
    n++;
  }
  if (n && dark / n > 0.75) { h = y; break; }
}
const imgData = new ImageData(w, h);
for (let i = 0; i < w * h; i++) {
  const o = i * 4;
  imgData.data[o] = img.bitmap.data[o];
  imgData.data[o + 1] = img.bitmap.data[o + 1];
  imgData.data[o + 2] = img.bitmap.data[o + 2];
  imgData.data[o + 3] = 255;
}
const { computeFgWeight } = sandbox.window.EPD_BG_REMOVE;
const fg = computeFgWeight(imgData, { style: "patchwork" });
const fieldH = Math.min(h, 218);
const zones = [
  ["shower", x => x >= w * 0.30 && x <= w * 0.62, y => y >= fieldH * 0.18 && y < fieldH * 0.55],
  ["cloud", x => x >= w * 0.26 && x <= w * 0.58, y => y >= fieldH * 0.10 && y < fieldH * 0.54],
  ["bell", x => x <= w * 0.31, y => y >= fieldH * 0.66 && y <= fieldH * 0.97],
];
for (const [name, xf, yf] of zones) {
  let n = 0;
  for (let y = 0; y < fieldH; y++) for (let x = 0; x < w; x++) {
    if (!xf(x) || !yf(y)) continue;
    if (fg[y * w + x] > 0.5) n++;
  }
  console.log(name, "bandpass fg px:", n);
}
