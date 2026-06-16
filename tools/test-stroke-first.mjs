#!/usr/bin/env node
"use strict";
/** Quick PNG export mirroring v127 stroke-first seeds (no full bg-remove.js). */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp, rgbaToInt } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTCHA = path.join(__dirname, "..", "captcha");
const OUT = path.join(CAPTCHA, "out");
const file = process.argv[2] || "epd_captcha_collect_0001_1781257194272.jpg";

const STROKES = [
  [203, 211, 232], [196, 229, 222], [200, 221, 222], [254, 223, 229],
  [248, 253, 183], [214, 247, 178], [241, 254, 188], [212, 232, 157],
  [249, 254, 200], [239, 253, 205],
];
const STROKE_TOL = 0.040;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const hueDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };
const rgbHue = (r, g, b) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return 0;
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h / 6;
};

function boxBlur(ch, w, h, r) {
  const n = w * h, tmp = new Float32Array(n), out = new Float32Array(n), diam = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += ch[y * w + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / diam;
      sum += ch[y * w + clamp(x + r + 1, 0, w - 1)] - ch[y * w + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / diam;
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

function strokeMatch(r, g, b) {
  let best = 0;
  for (const [sr, sg, sb] of STROKES) {
    const d = Math.max(Math.abs(r - sr / 255), Math.abs(g - sg / 255), Math.abs(b - sb / 255));
    best = Math.max(best, clamp(1 - d / STROKE_TOL, 0, 1));
  }
  return best;
}

function splitMainH(data, w, h) {
  let top = h;
  for (let y = h - 1; y >= Math.max(0, h - 120); y--) {
    let dark = 0, n = 0;
    for (let x = 0; x < w; x += 4) {
      const o = (y * w + x) * 4;
      if (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114 < 40) dark++;
      n++;
    }
    if (n && dark / n > 0.75) { top = y; break; }
  }
  while (top > 0) {
    let dark = 0, n = 0;
    for (let x = 0; x < w; x += 4) {
      const o = ((top - 1) * w + x) * 4;
      if (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114 < 40) dark++;
      n++;
    }
    if (dark / n > 0.6) top--; else break;
  }
  return Math.max(1, top);
}

const img = await Jimp.read(path.join(CAPTCHA, file));
const w = img.bitmap.width, h = splitMainH(img.bitmap.data, w, img.bitmap.height);
const n = w * h, d = img.bitmap.data;
const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
const gray = new Float32Array(n), sat = new Float32Array(n), hue = new Float32Array(n);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x, o = i * 4;
  r[i] = d[o] / 255; g[i] = d[o + 1] / 255; b[i] = d[o + 2] / 255;
  gray[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
  const mx = Math.max(r[i], g[i], b[i]), mn = Math.min(r[i], g[i], b[i]);
  sat[i] = mx - mn;
  hue[i] = rgbHue(r[i], g[i], b[i]);
}
const edge = new Float32Array(n);
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  edge[i] = Math.hypot(gray[i + 1] - gray[i - 1], gray[i + w] - gray[i - w]);
}
const edgeSat = new Float32Array(n);
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  edgeSat[i] = Math.hypot(sat[i + 1] - sat[i - 1], sat[i + w] - sat[i - w]);
}
const bgR = boxBlur(r, w, h, 32), bgG = boxBlur(g, w, h, 32), bgB = boxBlur(b, w, h, 32);
const locR = boxBlur(r, w, h, 6), locG = boxBlur(g, w, h, 6), locB = boxBlur(b, w, h, 6);
const sm = new Float32Array(n), ct = new Float32Array(n), wt = new Float32Array(n);
for (let i = 0; i < n; i++) {
  sm[i] = strokeMatch(r[i], g[i], b[i]);
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
  ct[i] = clamp(cool * 10, 0, 1);
  wt[i] = clamp(warm * 10, 0, 1);
}

const seed = new Uint8Array(n);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x;
  const es = edgeSat[i], e = edge[i];
  const hsBg = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const hsTile = hueDist(hue[i], rgbHue(locR[i], locG[i], locB[i]));
  if (e < 0.004 && es < 0.0035) continue;
  if (e >= 0.009 && es < 0.0035 && sm[i] < 0.22 && ct[i] < 0.022) continue;
  if (hsTile < 0.022 && sm[i] < 0.28 && ct[i] < 0.024 && wt[i] < 0.022) continue;
  if (sm[i] >= 0.32 && es >= 0.004) { seed[i] = 1; continue; }
  if ((ct[i] >= 0.024 || wt[i] >= 0.022) && hsBg >= 0.038 && es >= 0.0038 && e >= 0.004) seed[i] = 1;
}

let dark = 0;
fs.mkdirSync(OUT, { recursive: true });
const out = new Jimp({ width: w, height: h, color: 0xffffffff });
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const v = seed[y * w + x] ? 0 : 255;
  if (v < 200) dark++;
  out.setPixelColor(rgbaToInt(v, v, v, 255), x, y);
}
const outPath = path.join(OUT, file.replace(/\.jpe?g$/i, "") + "_stroke_first.png");
await out.write(outPath);
console.log(`${file} ${w}x${h} darkPx=${dark} → ${outPath}`);
