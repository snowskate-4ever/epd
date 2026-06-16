#!/usr/bin/env node
"use strict";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PALETTE = [
  ["#CBD3E8", 203, 211, 232],
  ["#C4E5DE", 196, 229, 222],
  ["#C8DDDE", 200, 221, 222],
  ["#FEDFE5", 254, 223, 229],
  ["#F8FDB7", 248, 253, 183],
  ["#D6F7B2", 214, 247, 178],
  ["#F1FEBC", 241, 254, 188],
  ["#D4E89D", 212, 232, 157],
  ["#F9FEC8", 249, 254, 200],
  ["#EFFDCD", 239, 253, 205],
];
const TOL = 0.040;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rgbHue = (r, g, b) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return 0;
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h / 6;
};
const hueDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };

function matchPalette(r, g, b) {
  let best = 0, name = null;
  for (const [hex, pr, pg, pb] of PALETTE) {
    const d = Math.hypot(r - pr / 255, g - pg / 255, b - pb / 255);
    const m = clamp(1 - d / TOL, 0, 1);
    if (m > best) { best = m; name = hex; }
  }
  return { best, name };
}

function hexOf(r, g, b) {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

const file = process.argv[2] || "epd_captcha_collect_0001_1781257194272.jpg";
const img = await Jimp.read(path.join(__dirname, "..", "captcha", file));
const w = img.bitmap.width, h = 270, n = w * h;
const id = img.bitmap.data;
const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), gray = new Float32Array(n), hue = new Float32Array(n);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x, o = i * 4;
  r[i] = id[o] / 255; g[i] = id[o + 1] / 255; b[i] = id[o + 2] / 255;
  gray[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
  hue[i] = rgbHue(r[i], g[i], b[i]);
}
const edge = new Float32Array(n);
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  edge[i] = Math.hypot(gray[i + 1] - gray[i - 1], gray[i + w] - gray[i - w]);
}

const rois = {
  heart: [40, 30, 120, 100], bell: [10, 150, 140, 210], fp: [380, 20, 470, 130],
  crown: [250, 80, 340, 160], shower: [180, 60, 280, 150], pink: [380, 165, 100, 90],
};

console.log(`Stroke color sample: ${file}\nPalette: ${PALETTE.map((p) => p[0]).join(" ")}\n`);

for (const [name, [x0, y0, x1, y1]] of Object.entries(rois)) {
  const buckets = new Map();
  let strokePx = 0, matched = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x;
    if (edge[i] < 0.008) continue;
    strokePx++;
    const hex = hexOf(r[i], g[i], b[i]);
    const { best, name: pal } = matchPalette(r[i], g[i], b[i]);
    if (best >= 0.35) matched++;
    const key = hex;
    const prev = buckets.get(key) || { count: 0, pal, match: best };
    prev.count++;
    buckets.set(key, prev);
  }
  const top = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  console.log(`${name}: strokePx=${strokePx}, paletteMatch>=0.35: ${((matched / Math.max(strokePx, 1)) * 100).toFixed(1)}%`);
  for (const [hex, info] of top) {
    console.log(`  ${hex} x${info.count} nearest=${info.pal || "-"} match=${info.match.toFixed(2)}`);
  }
}

console.log("\nNew candidates (edge px, no palette match, freq>=3):");
const cand = new Map();
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x;
  if (edge[i] < 0.010) continue;
  const { best } = matchPalette(r[i], g[i], b[i]);
  if (best >= 0.25) continue;
  const hex = hexOf(r[i], g[i], b[i]);
  cand.set(hex, (cand.get(hex) || 0) + 1);
}
for (const [hex, cnt] of [...cand.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${hex} x${cnt}`);
}
