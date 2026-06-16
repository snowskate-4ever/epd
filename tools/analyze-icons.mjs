#!/usr/bin/env node
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTCHA_DIR = path.join(__dirname, "..", "captcha");
const FILE = "epd_captcha_collect_0001_1781257194272.jpg";

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

function fineEdge(g, w, h) {
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    e[i] = Math.hypot(g[i + 1] - g[i - 1], g[i + w] - g[i - w]);
  }
  return e;
}

// Approximate icon ROIs (480x270 main field)
const ROIS = {
  heart: { x: 30, y: 20, w: 90, h: 80, label: "heart (OK)" },
  cloud: { x: 175, y: 55, w: 110, h: 70, label: "cloud (BAD)" },
  crown: { x: 300, y: 70, w: 80, h: 70, label: "crown (OK)" },
  fingerprint: { x: 380, y: 15, w: 90, h: 90, label: "fingerprint (OK)" },
  bell: { x: 55, y: 155, w: 90, h: 90, label: "bell (BAD)" },
  pink: { x: 380, y: 175, w: 80, h: 70, label: "pink icon (BAD)" },
};

function statsInRoi(data, w, roi, edge, bgR, bgG, bgB, hue, sat) {
  const vals = { edge: [], score: [], hueShift: [], cool: [], warm: [], dist: [], tint: [], sat: [], pinkHue: 0 };
  for (let y = roi.y; y < roi.y + roi.h; y++) {
    for (let x = roi.x; x < roi.x + roi.w; x++) {
      const i = y * w + x, o = i * 4;
      const r = data[o] / 255, g = data[o + 1] / 255, b = data[o + 2] / 255;
      const dr = r - bgR[i], dg = g - bgG[i], db = b - bgB[i];
      const colorDist = Math.hypot(dr, dg, db);
      const localHue = rgbHue(bgR[i], bgG[i], bgB[i]);
      const hueShift = hueDist(hue[i], localHue);
      const cool = (b - bgB[i]) - (r - bgR[i]);
      const warm = (r - bgR[i]) - (g - bgG[i]);
      const chromaGate = clamp((hueShift - 0.03) * 8, 0, 1);
      const coolGate = clamp(cool * 12, 0, 1);
      const warmGate = clamp(warm * 14, 0, 1);
      const distGate = clamp((colorDist - 0.01) * 9, 0, 1);
      const gate = Math.max(chromaGate, coolGate, warmGate);
      const score = edge[i] * gate * (0.4 + 0.6 * distGate);
      const tint = Math.max(clamp(cool * 10, 0, 1), clamp(warm * 10, 0, 1));
      const h = hue[i];
      const isPinkHue = h > 0.82 || h < 0.12;
      if (edge[i] > 0.015) {
        vals.edge.push(edge[i]);
        vals.score.push(score);
        vals.hueShift.push(hueShift);
        vals.cool.push(cool);
        vals.warm.push(warm);
        vals.dist.push(colorDist);
        vals.tint.push(tint);
        vals.sat.push(sat[i]);
        if (isPinkHue) vals.pinkHue++;
      }
    }
  }
  const avg = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const p50 = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.5)]; };
  const p90 = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; };
  return {
    edgePixels: vals.edge.length,
    avgEdge: avg(vals.edge).toFixed(4),
    p50Score: p50(vals.score).toFixed(4),
    p90Score: p90(vals.score).toFixed(4),
    avgHueShift: avg(vals.hueShift).toFixed(4),
    avgCool: avg(vals.cool).toFixed(4),
    avgWarm: avg(vals.warm).toFixed(4),
    avgDist: avg(vals.dist).toFixed(4),
    avgTint: avg(vals.tint).toFixed(4),
    avgSat: avg(vals.sat).toFixed(4),
    pinkEdgePx: vals.pinkHue,
  };
}

async function main() {
  const img = await Jimp.read(path.join(CAPTCHA_DIR, FILE));
  const w = img.bitmap.width, h = 210; // main field ~210
  const data = img.bitmap.data;
  const n = w * h;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  const gray = new Float32Array(n), hue = new Float32Array(n), sat = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = i * 4;
    r[i] = data[o] / 255; g[i] = data[o + 1] / 255; b[i] = data[o + 2] / 255;
    gray[i] = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
    const hs = rgbHueSat(r[i], g[i], b[i]); hue[i] = hs.h; sat[i] = hs.s;
  }
  const edge = fineEdge(gray, w, h);
  const bgR = boxBlur(r, w, h, 32), bgG = boxBlur(g, w, h, 32), bgB = boxBlur(b, w, h, 32);

  console.log(`\n=== Analysis: ${FILE} (${w}x${h}) ===\n`);
  for (const [name, roi] of Object.entries(ROIS)) {
    const s = statsInRoi(data, w, roi, edge, bgR, bgG, bgB, hue, sat);
    console.log(`${roi.label}:`);
    console.log(`  edge px: ${s.edgePixels}, avgEdge: ${s.avgEdge}`);
    console.log(`  score p50/p90: ${s.p50Score} / ${s.p90Score}`);
    console.log(`  hueShift: ${s.avgHueShift}, cool: ${s.avgCool}, warm: ${s.avgWarm}`);
    console.log(`  colorDist: ${s.avgDist}, tint: ${s.avgTint}, sat: ${s.avgSat}, pinkEdge: ${s.pinkEdgePx}`);
    console.log();
  }
}

main().catch(console.error);
