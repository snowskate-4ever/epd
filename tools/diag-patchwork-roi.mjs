#!/usr/bin/env node
"use strict";
/** ROI dark-pixel counts per pipeline stage for patchwork captcha. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";
import { Jimp, rgbaToInt } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CAPTCHA = path.join(ROOT, "captcha");
const OUT = path.join(CAPTCHA, "out");
const file = process.argv[2] || "epd_captcha_collect_0001_1781257194272.jpg";

const ROIS = {
  center: [180, 55, 290, 155],
  crown: [300, 70, 380, 150],
  fingerprint: [390, 70, 470, 150],
  heart: [30, 30, 110, 110],
  bell: [40, 140, 120, 210],
};

function roiCount(fg, w, h, [x0, y0, x1, y1]) {
  let n = 0, tot = 0;
  for (let y = y0; y < y1 && y < h; y++) {
    for (let x = x0; x < x1 && x < w; x++) {
      tot++;
      if (fg[y * w + x] > 0.5) n++;
    }
  }
  return { n, tot, pct: tot ? (100 * n / tot).toFixed(1) : "0" };
}

function splitMainH(data, w, fullH) {
  let top = fullH;
  for (let y = fullH - 1; y >= Math.max(0, fullH - 120); y--) {
    let dark = 0, nn = 0;
    for (let x = 0; x < w; x += 4) {
      const o = (y * w + x) * 4;
      if (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114 < 40) dark++;
      nn++;
    }
    if (nn && dark / nn > 0.75) { top = y; break; }
  }
  return Math.max(1, top);
}

const code = fs.readFileSync(path.join(ROOT, "bg-remove.js"), "utf8");
class ImageData {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
}
const document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {} }) }) };
const sandbox = { console, Math, Float32Array, Uint8Array, Uint8ClampedArray, Int32Array, Array, Object, ImageData, document, window: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { removeBackground, version: BG_REMOVE_VERSION } = sandbox.window.EPD_BG_REMOVE;

const img = await Jimp.read(path.join(CAPTCHA, file));
const w = img.bitmap.width;
const h = splitMainH(img.bitmap.data, w, img.bitmap.height);
const imgData = new ImageData(w, h);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const si = (y * w + x) * 4, di = si;
    imgData.data[di] = img.bitmap.data[si];
    imgData.data[di + 1] = img.bitmap.data[si + 1];
    imgData.data[di + 2] = img.bitmap.data[si + 2];
    imgData.data[di + 3] = 255;
  }
}
const result = removeBackground(imgData, { style: "auto" });
const arr = result.weight;

console.log("version:", BG_REMOVE_VERSION, "field:", w, "x", h);
for (const [name, roi] of Object.entries(ROIS)) {
  const c = roiCount(arr, w, h, roi);
  console.log(`  ${name}: ${c.n}/${c.tot} (${c.pct}%)`);
}

fs.mkdirSync(OUT, { recursive: true });
const out = new Jimp({ width: w, height: h, color: 0xffffffff });
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const v = arr[y * w + x] > 0.5 ? 0 : 255;
    out.setPixelColor(rgbaToInt(v, v, v, 255), x, y);
  }
}
const outPath = path.join(OUT, file.replace(/\.jpe?g$/i, "_diag.png"));
await out.write(outPath);
console.log("saved:", outPath);
