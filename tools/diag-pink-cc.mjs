#!/usr/bin/env node
"use strict";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(__dirname, "..", "captcha", "epd_captcha_collect_0001_1781257194272.jpg");

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const hueDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };

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

function rgbHue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return 0;
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h / 6;
}

function camoScore(r, g, b, hue, sat, edge, edgeSat, satRes, lumRes, bgR, bgG, bgB, i, w, h) {
  const y = (i / w) | 0, x = i - y * w;
  const fieldH = Math.min(h, 218);
  const inPinkZone = y > fieldH * 0.60 && x > w * 0.70;
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  const cool = (b[i] - bgB[i]) - (r[i] - bgR[i]);
  const warm = (r[i] - bgR[i]) - (g[i] - bgG[i]);
  const es = edgeSat[i];
  if (inPinkZone && hueShift < 0.05 && es > 0.016) {
    let sig = Math.max(satRes[i] * 90, es * 12, lumRes[i] * 20);
    if (warm > 0.004 || hue[i] > 0.66 || hue[i] < 0.12) sig = Math.max(sig * 1.35, 0.06);
    else sig = Math.max(sig, es * 5.5);
    return Math.max(edge[i], es * 3.2) * sig * clamp((0.095 - hueShift) * 18, 0.25, 1);
  }
  const gate = Math.max(clamp((hueShift - 0.03) * 8, 0, 1), clamp(cool * 12, 0, 1), clamp(warm * 14, 0, 1));
  if (gate >= 0.25 || hueShift > 0.075 || (sat[i] < 0.14 && es < 0.02)) return 0;
  let sig = Math.max(satRes[i] * 60, es * 8, lumRes[i] * 15);
  const warmPink = warm > 0.008 && (hue[i] > 0.68 || hue[i] < 0.1);
  if (warmPink) sig = Math.max(sig * 1.45, 0.09);
  if (sig < 0.06) return 0;
  return Math.max(edge[i], es * 2.4) * sig * clamp((0.085 - hueShift) * 20, 0, 1);
}

const img = await Jimp.read(IMG);
const w = img.bitmap.width, h = 270;
const id = img.bitmap.data, n = w * h;
const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
const gray = new Float32Array(n), hue = new Float32Array(n), sat = new Float32Array(n);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x, o = i * 4;
  r[i] = id[o] / 255; g[i] = id[o + 1] / 255; b[i] = id[o + 2] / 255;
  gray[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
  const mx = Math.max(r[i], g[i], b[i]), mn = Math.min(r[i], g[i], b[i]), d = mx - mn;
  sat[i] = d;
  hue[i] = d < 0.02 ? 0 : ((mx === r[i] ? (g[i] - b[i]) / d + (g[i] < b[i] ? 6 : 0) : mx === g[i] ? (b[i] - r[i]) / d + 2 : (r[i] - g[i]) / d + 4) / 6);
}
const edge = new Float32Array(n), edgeSat = new Float32Array(n);
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  edge[i] = Math.hypot(gray[i + 1] - gray[i - 1], gray[i + w] - gray[i - w]);
  edgeSat[i] = Math.hypot(sat[i + 1] - sat[i - 1], sat[i + w] - sat[i - w]);
}
const satRing = boxBlur(sat, w, h, 3), grayRing = boxBlur(gray, w, h, 3);
const bgR = boxBlur(r, w, h, 32), bgG = boxBlur(g, w, h, 32), bgB = boxBlur(b, w, h, 32);
const satRes = new Float32Array(n), lumRes = new Float32Array(n);
for (let i = 0; i < n; i++) {
  satRes[i] = Math.max(0, sat[i] - satRing[i]);
  lumRes[i] = Math.abs(gray[i] - grayRing[i]);
}
const camo = new Float32Array(n);
for (let i = 0; i < n; i++) camo[i] = camoScore(r, g, b, hue, sat, edge, edgeSat, satRes, lumRes, bgR, bgG, bgB, i, w, h);

const fieldH = Math.min(h, 218);
const x0 = Math.floor(w * 0.815), y0 = Math.floor(fieldH * 0.72);
const anchorX = w * 0.915, anchorY = fieldH * 0.885;
const bin = new Uint8Array(n);
for (let y = y0; y < h; y++) for (let x = x0; x < w; x++) {
  const i = y * w + x;
  const hueShift = hueDist(hue[i], rgbHue(bgR[i], bgG[i], bgB[i]));
  if (camo[i] >= 0.02) bin[i] = 1;
  else if (hueShift < 0.055 && edgeSat[i] > 0.014 && satRes[i] > 0.0004) bin[i] = 1;
}

const seen = new Int32Array(n);
const dx = [1, -1, 0, 0, 1, 1, -1, -1];
const dy = [0, 0, 1, -1, 1, -1, 1, -1];
const blobs = [];
for (let sy = y0; sy < h; sy++) for (let sx = x0; sx < w; sx++) {
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
      if (nx < x0 || ny < y0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!bin[ni] || seen[ni]) continue;
      seen[ni] = 1; q.push(ni);
    }
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const dist = Math.hypot(cx - anchorX, cy - anchorY);
  blobs.push({ area: pixels.length, minX, maxX, minY, maxY, cx: cx.toFixed(1), cy: cy.toFixed(1), dist: dist.toFixed(1), kept: pixels.length >= 12 && pixels.length <= 1200 });
}
blobs.sort((a, b) => a.dist - b.dist);
console.log("zone", { x0, y0, anchorX, anchorY, fieldH });
console.log("blobs", blobs.length);
for (const b of blobs.slice(0, 12)) console.log(b);
