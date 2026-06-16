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

function hollowInterior(bin, x0, y0, x1, y1, w, h, passes, nbrCut) {
  const thin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (bin[i]) thin[i] = 1;
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

function dilateCardinal(bin, zone, w, h) {
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
  const q = [];
  const vis = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (ring[i]) { q.push(i); vis[i] = 1; }
  const dx8 = [1, -1, 0, 0, 1, 1, -1, -1];
  const dy8 = [0, 0, 1, -1, 1, -1, 1, -1];
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

const img = await Jimp.read(IMG);
const w = img.bitmap.width, h = 270, n = w * h;
const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), gray = new Float32Array(n), sat = new Float32Array(n);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x, o = i * 4;
  r[i] = img.bitmap.data[o] / 255;
  g[i] = img.bitmap.data[o + 1] / 255;
  b[i] = img.bitmap.data[o + 2] / 255;
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
const satRing = boxBlur(sat, w, h, 3);
const grayRing = boxBlur(gray, w, h, 3);
const satRes = new Float32Array(n);
const lumRes = new Float32Array(n);
for (let i = 0; i < n; i++) {
  satRes[i] = Math.max(0, sat[i] - satRing[i]);
  lumRes[i] = Math.abs(gray[i] - grayRing[i]);
}
const edgeSat = buildSatEdge(sat, w, h);
const coolTint = new Float32Array(n);
for (let i = 0; i < n; i++) coolTint[i] = clamp(coolRaw[i] * 10, 0, 1);

const fieldH = 218;
const fp = (x, y) => x >= w * 0.80 && y >= fieldH * 0.08 && y < fieldH * 0.60;
const x0 = Math.floor(w * 0.80), y0 = Math.floor(fieldH * 0.08), x1 = w, y1 = Math.floor(fieldH * 0.60);

function build(cfg) {
  const thin = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!fp(x, y)) continue;
    const i = y * w + x;
    if (edgeSat[i] >= cfg.es && satRes[i] >= cfg.sr && coolTint[i] >= cfg.ct) thin[i] = 1;
    else if (cfg.cool && coolEdge[i] >= 0.001 && coolTint[i] >= cfg.ct * 0.85 && edge[i] >= 0.007) thin[i] = 1;
    else if (cfg.lum && lumRes[i] >= 0.010 && coolTint[i] >= 0.026 && edge[i] >= 0.006) thin[i] = 1;
  }
  let ring = hollowInterior(thin, x0, y0, x1, y1, w, h, cfg.hp, cfg.hc);
  if (cfg.bfs) {
    const cand = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!fp(i % w, (i / w) | 0)) continue;
      if (edgeSat[i] >= 0.006 && satRes[i] >= 0.001 && coolTint[i] >= 0.028) cand[i] = 1;
      else if (edge[i] >= 0.007 && coolTint[i] >= 0.026 && satRes[i] >= 0.0008) cand[i] = 1;
      else if (coolEdge[i] >= 0.0008 && coolTint[i] >= 0.028 && lumRes[i] >= 0.008) cand[i] = 1;
    }
    ring = bfsGrow(ring, cand, fp, w, h);
  }
  for (let d = 0; d < (cfg.dil || 0); d++) ring = dilateCardinal(ring, fp, w, h);
  return ring;
}

function recall(ring) {
  let stroke = 0, hit = 0;
  for (let y = 15; y < 120; y++) for (let x = 380; x < 470; x++) {
    if (!fp(x, y)) continue;
    const i = y * w + x;
    const isStroke = edge[i] > 0.010 || coolTint[i] > 0.04 || edgeSat[i] > 0.008;
    if (!isStroke) continue;
    stroke++;
    if (ring[i]) hit++;
  }
  return { px: ring.reduce((a, v) => a + v, 0), recall: ((hit / stroke) * 100).toFixed(1) + "%" };
}

const configs = [
  { name: "v77 baseline", es: 0.009, sr: 0.0015, ct: 0.038, hp: 2, hc: 6, bfs: 0, dil: 1, cool: 0 },
  { name: "bfs+lower", es: 0.008, sr: 0.0012, ct: 0.032, hp: 2, hc: 6, bfs: 1, dil: 1, cool: 1 },
  { name: "v79 sim", es: 0.008, sr: 0.0012, ct: 0.032, hp: 2, hc: 5, bfs: 1, dil: 2, cool: 1, lum: 1 },
];

for (const cfg of configs) {
  const ring = build(cfg);
  console.log(cfg.name, recall(ring));
}
