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
const { removeBackground } = sandbox.window.EPD_BG_REMOVE;

const file = "epd_captcha_collect_0001_1781257194272.jpg";
const img = await Jimp.read(path.join(ROOT, "captcha", file));
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
const { weight: fg } = removeBackground(imgData, { style: "auto" });
const bin = new Uint8Array(w * h);
for (let i = 0; i < w * h; i++) bin[i] = fg[i] > 0.5 ? 1 : 0;
const seen = new Int32Array(w * h);
const dx = [1,-1,0,0,1,1,-1,-1], dy = [0,0,1,-1,1,-1,1,-1];
const comps = [];
for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
  const si = sy * w + sx;
  if (!bin[si] || seen[si]) continue;
  const q = [si]; seen[si] = 1; const pixels = [];
  let minX = sx, maxX = sx, minY = sy, maxY = sy;
  for (let qi = 0; qi < q.length; qi++) {
    const ci = q[qi]; pixels.push(ci);
    const cy = (ci / w) | 0, cx = ci - cy * w;
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    for (let d = 0; d < 8; d++) {
      const nx = cx + dx[d], ny = cy + dy[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!bin[ni] || seen[ni]) continue;
      seen[ni] = 1; q.push(ni);
    }
  }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const cx = ((minX + maxX) / 2) | 0, cy = ((minY + maxY) / 2) | 0;
  comps.push({ area: pixels.length, bw, bh, fill: (pixels.length / (bw * bh)).toFixed(3), cx, cy, centerFg: bin[cy * w + cx] });
}
comps.sort((a, b) => b.area - a.area);
console.log("top components:");
for (const c of comps.slice(0, 12)) console.log(c);
