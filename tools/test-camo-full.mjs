#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp, rgbaToInt } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "captcha", "out", "epd_captcha_collect_0001_1781257194272_bg.png");

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

function scorePatchwork(r, g, b, hue, edge, bgR, bgG, bgB, i) {
  const dr = r[i] - bgR[i], dg = g[i] - bgG[i], db = b[i] - bgB[i];
  const colorDist = Math.hypot(dr, dg, db);
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
  const gate = Math.max(clamp((hueShift - 0.03) * 8, 0, 1), clamp(cool * 12, 0, 1), clamp(warm * 14, 0, 1));
  const distGate = clamp((colorDist - 0.01) * 9, 0, 1);
  return edge[i] * gate * (0.4 + 0.6 * distGate);
}

function camouflageScore(r, g, b, hue, sat, edge, edgeSat, bgR, bgG, bgB, i) {
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  const chromaGate = clamp((hueShift - 0.03) * 8, 0, 1);
  const coolGate = clamp(cool * 12, 0, 1);
  if (chromaGate > 0.2 || coolGate > 0.35 || hueShift > 0.07 || sat[i] < 0.21) return 0;
  if (edgeSat[i] < 0.012 && edge[i] < 0.015) return 0;
  const e = Math.max(edgeSat[i] * 3, edge[i] * 0.6);
  return e * sat[i] * clamp((0.08 - hueShift) * 20, 0, 1) * 6;
}

function filterComponents(score, w, h, thresh) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = score[i] >= thresh ? 1 : 0;
  const fg = new Float32Array(w * h);
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const ss = Math.min(bw, bh), ls = Math.max(bw, bh);
    if (area < 35 || area > 9000 || (ls / ss > 7 && ss < 14 && ls > 35)) continue;
    for (const pi of pixels) fg[pi] = 1;
  }
  return boxBlur(fg, w, h, 1);
}

function appendCamouflageFg(fg, camo, w, h) {
  const CAMO_TH = 0.42;
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = camo[i] >= CAMO_TH ? 1 : 0;
  const seen = new Int32Array(w * h);
  const blobs = [];
  const dx = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1; const pixels = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy, sum = 0, overlap = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pixels.push(ci); sum += camo[ci];
      if (fg[ci] > 0.35) overlap++;
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pixels.length;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const ss = Math.min(bw, bh), ls = Math.max(bw, bh);
    const cy = (minY + maxY) * 0.5;
    if (area < 6 || area > 50 || ls / Math.max(1, ss) > 9) continue;
    if (overlap / area > 0.15) continue;
    if (cy < h * 0.55) continue;
    blobs.push({ pixels, avg: sum / area, cy });
  }
  blobs.sort((a, b) => b.avg - a.avg);
  for (const bl of blobs.slice(0, 3)) for (const pi of bl.pixels) fg[pi] = Math.max(fg[pi], 0.9);
  return blobs.slice(0, 3);
}

function roiFg(fg, w, rx, ry, rw, rh) {
  let n = 0;
  for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) if (fg[y * w + x] >= 0.5) n++;
  return n;
}

const img = await Jimp.read(path.join(__dirname, "..", "captcha", "epd_captcha_collect_0001_1781257194272.jpg"));
const w = img.bitmap.width, h = 270, data = img.bitmap.data, n = w * h;
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
const score = new Float32Array(n);
for (let i = 0; i < n; i++) score[i] = scorePatchwork(r, g, b, hue, edge, bgR, bgG, bgB, i);
const dil = boxBlur(score, w, h, 1);
for (let i = 0; i < n; i++) score[i] = Math.max(score[i], dil[i] * 0.85);
const vals = [];
for (let i = 0; i < n; i++) if (score[i] > 0.02) vals.push(score[i]);
vals.sort((a, b) => a - b);
const thresh = clamp(Math.min(vals[Math.floor(vals.length * 0.85)] * 0.5, vals[Math.floor(vals.length * 0.5)] * 1.25), 0.04, 0.2);
const camo = new Float32Array(n);
for (let i = 0; i < n; i++) camo[i] = camouflageScore(r, g, b, hue, sat, edge, edgeSat, bgR, bgG, bgB, i);
let fg = filterComponents(score, w, h, thresh);
const blobs = appendCamouflageFg(fg, camo, w, h);
const fg2 = boxBlur(fg, w, h, 1);
for (let i = 0; i < n; i++) fg[i] = Math.max(fg[i], fg2[i] * 0.75);

let dark = 0;
const out = new Jimp({ width: w, height: h, color: 0xffffffff });
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x;
  const v = Math.round(255 * (1 - clamp(fg[i], 0, 1)));
  if (v < 200) dark++;
  out.setPixelColor(rgbaToInt(v, v, v, 255), x, y);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await out.write(OUT);
console.log({
  thresh, dark,
  heart: roiFg(fg, w, 30, 20, 90, 80),
  crown: roiFg(fg, w, 300, 70, 80, 70),
  bell: roiFg(fg, w, 55, 155, 90, 90),
  cloud: roiFg(fg, w, 175, 55, 110, 70),
  pink: roiFg(fg, w, 385, 175, 70, 35),
  camoBlobs: blobs.map(b => ({ area: b.pixels.length, avg: +b.avg.toFixed(2), cy: b.cy })),
});
