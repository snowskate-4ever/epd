#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTCHA = path.join(__dirname, "..", "captcha");
const file = process.argv[2] || "epd_captcha_collect_0001_1781257194272.jpg";
const ROI = [180, 55, 290, 155];

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
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), diam = r * 2 + 1;
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

const STROKES = [
  [203, 211, 232], [196, 229, 222], [200, 221, 222], [254, 223, 229],
  [248, 253, 183], [214, 247, 178], [241, 254, 188], [212, 232, 157],
];
function strokeMatch(r, g, b) {
  let best = 0;
  for (const [sr, sg, sb] of STROKES) {
    const d = Math.max(Math.abs(r - sr / 255), Math.abs(g - sg / 255), Math.abs(b - sb / 255));
    best = Math.max(best, clamp(1 - d / 0.04, 0, 1));
  }
  return best;
}

const img = await Jimp.read(path.join(CAPTCHA, file));
const w = img.bitmap.width, fullH = img.bitmap.height;
let h = fullH;
for (let y = fullH - 1; y >= fullH - 120; y--) {
  let dark = 0, n = 0;
  for (let x = 0; x < w; x += 4) {
    const o = (y * w + x) * 4;
    if (img.bitmap.data[o] * 0.299 + img.bitmap.data[o + 1] * 0.587 + img.bitmap.data[o + 2] * 0.114 < 40) dark++;
    n++;
  }
  if (n && dark / n > 0.75) { h = y; break; }
}
const n = w * h, d = img.bitmap.data;
const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
const sat = new Float32Array(n), hue = new Float32Array(n), gray = new Float32Array(n);
for (let i = 0; i < n; i++) {
  const o = i * 4;
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
const loc6R = boxBlur(r, w, h, 6), loc6G = boxBlur(g, w, h, 6), loc6B = boxBlur(b, w, h, 6);
const loc24R = boxBlur(r, w, h, 24), loc24G = boxBlur(g, w, h, 24), loc24B = boxBlur(b, w, h, 24);
const bgR = boxBlur(r, w, h, 32), bgG = boxBlur(g, w, h, 32), bgB = boxBlur(b, w, h, 32);

const [x0, y0, x1, y1] = ROI;
const stats = { bandHit: 0, tintHit: 0, seedHit: 0, sm: [], ct: [], band: [], es: [] };
for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
  const i = y * w + x;
  const small = Math.hypot(r[i] - loc6R[i], g[i] - loc6G[i], b[i] - loc6B[i]);
  const large = Math.hypot(r[i] - loc24R[i], g[i] - loc24G[i], b[i] - loc24B[i]);
  const band = small - large * 0.55;
  const es = edgeSat[i];
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
  const ct = clamp(cool * 10, 0, 1);
  const wt = clamp(warm * 10, 0, 1);
  const hsBg = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const sm = strokeMatch(r[i], g[i], b[i]);
  stats.sm.push(sm); stats.ct.push(Math.max(ct, wt)); stats.band.push(band); stats.es.push(es);
  if (band > 0.010 && es > 0.004 && small > 0.007) stats.bandHit++;
  if ((ct >= 0.020 || wt >= 0.018) && hsBg >= 0.032 && es >= 0.0032 && edge[i] >= 0.003) stats.tintHit++;
  if (sm >= 0.32 && es >= 0.004) stats.seedHit++;
  else if ((ct >= 0.024 || wt >= 0.022) && hsBg >= 0.038 && es >= 0.0038 && edge[i] >= 0.004) stats.seedHit++;
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * p)]; };
console.log("center ROI", ROI, "pixels", stats.sm.length);
console.log("  bandHit:", stats.bandHit, "tintHit:", stats.tintHit, "seedHit:", stats.seedHit);
console.log("  sm p50/p85:", pct(stats.sm, 0.5).toFixed(3), pct(stats.sm, 0.85).toFixed(3));
console.log("  ct p50/p85:", pct(stats.ct, 0.5).toFixed(3), pct(stats.ct, 0.85).toFixed(3));
console.log("  band p50/p85:", pct(stats.band, 0.5).toFixed(4), pct(stats.band, 0.85).toFixed(4));
console.log("  es p50/p85:", pct(stats.es, 0.5).toFixed(4), pct(stats.es, 0.85).toFixed(4));
