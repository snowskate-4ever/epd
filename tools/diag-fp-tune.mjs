#!/usr/bin/env node
"use strict";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(__dirname, "..", "captcha", "epd_captcha_collect_0001_1781257194272.jpg");

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

function buildChannelEdge(ch, w, h) {
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    e[i] = Math.hypot(ch[i + 1] - ch[i - 1], ch[i + w] - ch[i - w]);
  }
  return e;
}

function hollow(mask, x0, y0, x1, y1, w, h, passes, nbrCut) {
  const thin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i]) thin[i] = 1;
  for (let pass = 0; pass < passes; pass++) for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
    const i = y * w + x;
    if (!thin[i]) continue;
    let nbr = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (thin[(y + dy) * w + (x + dx)]) nbr++;
    }
    if (nbr >= nbrCut) thin[i] = 0;
  }
  return thin;
}

function cardThin(mask, x0, y0, x1, y1, w, h, passes, cardMin) {
  const thin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i]) thin[i] = 1;
  for (let pass = 0; pass < passes; pass++) for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) {
    const i = y * w + x;
    if (!thin[i]) continue;
    let card = 0;
    if (thin[i - 1]) card++;
    if (thin[i + 1]) card++;
    if (thin[i - w]) card++;
    if (thin[i + w]) card++;
    if (card >= cardMin) thin[i] = 0;
  }
  return thin;
}

function dilate(bin, zone, w, h) {
  const out = new Uint8Array(bin);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!bin[y * w + x] || !zone(x, y)) continue;
    if (x > 0) out[y * w + x - 1] = 1;
    if (x < w - 1) out[y * w + x + 1] = 1;
    if (y > 0) out[y * w + x - w] = 1;
    if (y < h - 1) out[y * w + x + w] = 1;
  }
  return out;
}

function bfsGrow(ring, cand, zone, w, h) {
  const out = new Uint8Array(ring);
  const q = [], vis = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (ring[i]) { q.push(i); vis[i] = 1; }
  const dx8 = [1, -1, 0, 0, 1, 1, -1, -1], dy8 = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let qi = 0; qi < q.length; qi++) {
    const ci = q[qi];
    const cy = (ci / w) | 0, cx = ci - cy * w;
    for (let d = 0; d < 8; d++) {
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !zone(nx, ny)) continue;
      const ni = ny * w + nx;
      if (vis[ni] || !cand[ni]) continue;
      vis[ni] = 1;
      q.push(ni);
      out[ni] = 1;
    }
  }
  return out;
}

function pruneBlobs(fg, zone, w, h, minArea, fillCut, seamWide) {
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!zone(x, y)) continue;
    if (fg[y * w + x] > 0.5) bin[y * w + x] = 1;
  }
  const seen = new Int32Array(w * h);
  const dx = [1, -1, 0, 0, 1, 1, -1, -1], dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    if (!zone(sx, sy)) continue;
    const si = sy * w + sx;
    if (!bin[si] || seen[si]) continue;
    const q = [si]; seen[si] = 1;
    const pix = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    for (let qi = 0; qi < q.length; qi++) {
      const ci = q[qi]; pix.push(ci);
      const cy = (ci / w) | 0, cx = ci - cy * w;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let d = 0; d < 8; d++) {
        const nx = cx + dx[d], ny = cy + dy[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !zone(nx, ny)) continue;
        const ni = ny * w + nx;
        if (!bin[ni] || seen[ni]) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    const area = pix.length, bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    if (area < minArea) continue;
    const isSeam = bw / Math.max(bh, 1) > seamWide && area > 80 && bh < 14;
    if (fill > fillCut || isSeam) for (const pi of pix) fg[pi] = 0;
  }
}

const img = await Jimp.read(IMG);
const w = img.bitmap.width, h = 270, n = w * h;
const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), gray = new Float32Array(n), sat = new Float32Array(n);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x, o = i * 4;
  r[i] = img.bitmap.data[o] / 255; g[i] = img.bitmap.data[o + 1] / 255; b[i] = img.bitmap.data[o + 2] / 255;
  gray[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
  sat[i] = Math.max(r[i], g[i], b[i]) - Math.min(r[i], g[i], b[i]);
}
const edge = new Float32Array(n);
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  edge[i] = Math.hypot(gray[i + 1] - gray[i - 1], gray[i + w] - gray[i - w]);
}
const bgR = boxBlur(r, w, h, 32), bgG = boxBlur(g, w, h, 32), bgB = boxBlur(b, w, h, 32);
const coolRaw = new Float32Array(n);
for (let i = 0; i < n; i++) coolRaw[i] = (b[i] - bgB[i]) - (r[i] - bgR[i]);
const coolEdge = buildChannelEdge(coolRaw, w, h);
const satRing = boxBlur(sat, w, h, 3), grayRing = boxBlur(gray, w, h, 3);
const satRes = new Float32Array(n), lumRes = new Float32Array(n);
for (let i = 0; i < n; i++) {
  satRes[i] = Math.max(0, sat[i] - satRing[i]);
  lumRes[i] = Math.abs(gray[i] - grayRing[i]);
}
const edgeSat = buildSatEdge(sat, w, h);
const coolTint = new Float32Array(n);
for (let i = 0; i < n; i++) coolTint[i] = clamp(coolRaw[i] * 10, 0, 1);
const warmRaw = new Float32Array(n);
for (let i = 0; i < n; i++) warmRaw[i] = (r[i] - bgR[i]) - (b[i] - bgB[i]);
const warmTint = new Float32Array(n);
for (let i = 0; i < n; i++) warmTint[i] = clamp(warmRaw[i] * 10, 0, 1);

const fieldH = 218;
const fp = (x, y) => x >= w * 0.80 && y >= fieldH * 0.08 && y < fieldH * 0.60;
const x0 = Math.floor(w * 0.80), y0 = Math.floor(fieldH * 0.08), x1 = w, y1 = Math.floor(fieldH * 0.60);

function buildBase(cfg) {
  const thin = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!fp(x, y)) continue;
    const i = y * w + x;
    const tint = Math.max(coolTint[i], warmTint[i]);
    if (edgeSat[i] >= 0.008 && satRes[i] >= 0.0012 && tint >= 0.032) thin[i] = 1;
    else if (coolEdge[i] >= 0.001 && tint >= 0.028 && edge[i] >= 0.007) thin[i] = 1;
    else if (lumRes[i] >= 0.010 && tint >= 0.026 && edge[i] >= 0.006) thin[i] = 1;
  }
  let ring = hollow(thin, x0, y0, x1, y1, w, h, 2, 5);
  const cand = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!fp(x, y)) continue;
    const i = y * w + x;
    if (edgeSat[i] >= 0.006 && satRes[i] >= 0.001 && coolTint[i] >= 0.024) cand[i] = 1;
    else if (edge[i] >= 0.006 && satRes[i] >= 0.0008 && (coolTint[i] >= 0.020 || lumRes[i] >= 0.008)) cand[i] = 1;
    else if (coolEdge[i] >= 0.0007 && lumRes[i] >= 0.007 && edge[i] >= 0.005) cand[i] = 1;
  }
  ring = bfsGrow(ring, cand, fp, w, h);
  if (!cfg?.noDil) ring = dilate(ring, fp, w, h);
  return ring;
}

function recall(ring) {
  let stroke = 0, hit = 0, px = 0;
  for (let y = 15; y < 120; y++) for (let x = 380; x < 470; x++) {
    if (!fp(x, y)) continue;
    const i = y * w + x;
    if (ring[i]) px++;
    const isStroke = edge[i] > 0.010 || coolTint[i] > 0.04 || edgeSat[i] > 0.008;
    if (!isStroke) continue;
    stroke++;
    if (ring[i]) hit++;
  }
  return { px, recall: ((hit / stroke) * 100).toFixed(1) + "%" };
}

function applyPost(ring, cfg) {
  const fg = new Float32Array(n);
  for (let i = 0; i < n; i++) if (ring[i]) fg[i] = 1;
  let mask = ring;
  if (cfg.hp) mask = hollow(mask, x0, y0, x1, y1, w, h, cfg.hp, cfg.hc);
  if (cfg.cp) mask = cardThin(mask, x0, y0, x1, y1, w, h, cfg.cp, cfg.cc);
  if (cfg.postDil) mask = dilate(mask, fp, w, h);
  for (let i = 0; i < n; i++) fg[i] = mask[i] ? 1 : 0;
  if (cfg.fill < 0.99) pruneBlobs(fg, fp, w, h, cfg.minArea ?? 80, cfg.fill, cfg.seam ?? 3.5);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (fg[i] > 0.5) out[i] = 1;
  return out;
}

const combos = [
  { name: "base", hp: 0 },
  { name: "h3-6", hp: 3, hc: 6 },
  { name: "h4-5", hp: 4, hc: 5 },
  { name: "h5-5", hp: 5, hc: 5 },
  { name: "h3-6+c8-3", hp: 3, hc: 6, cp: 8, cc: 3 },
  { name: "h4-5+c6-3", hp: 4, hc: 5, cp: 6, cc: 3 },
  { name: "h3-6+c8-3+pr70", hp: 3, hc: 6, cp: 8, cc: 3, fill: 0.70 },
  { name: "h3-6+c8-3+pr65", hp: 3, hc: 6, cp: 8, cc: 3, fill: 0.65 },
  { name: "h3-6+c8-3+pr55", hp: 3, hc: 6, cp: 8, cc: 3, fill: 0.55 },
  { name: "no dilate", noDil: 1, hp: 3, hc: 6, cp: 8, cc: 3 },
  { name: "h3-6+c8-3+dil", hp: 3, hc: 6, cp: 8, cc: 3, postDil: 1 },
  { name: "h3-6+c8-3+dil+pr", hp: 3, hc: 6, cp: 8, cc: 3, postDil: 1, fill: 0.72 },
];

for (const c of combos) {
  const ring = applyPost(buildBase(c), { fill: 0.99, ...c });
  console.log(c.name, recall(ring));
}
