#!/usr/bin/env node
"use strict";
import { Jimp } from "jimp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "captcha", "out");
const w = 480;

const imgs = [
  {
    file: "epd_captcha_collect_0001_1781257194272.jpg",
    zones: { heart: [40, 30, 120, 100], bell: [10, 150, 140, 210], fp: [380, 20, 470, 130], crown: [250, 80, 340, 160], shower: [180, 60, 280, 150] },
  },
  {
    file: "epd_captcha_collect_0001_1781257441064.jpg",
    zones: { fp: [20, 120, 170, 220], cloud: [130, 20, 250, 120], key: [200, 80, 320, 180], lock: [300, 60, 400, 160], siren: [350, 120, 450, 210] },
  },
  {
    file: "epd_captcha_collect_0002_1781257507651.jpg",
    zones: { crown: [20, 40, 120, 120], heart: [100, 80, 200, 160], flower: [220, 90, 320, 170], cloud: [350, 20, 450, 100], clock: [350, 150, 450, 220] },
  },
  {
    file: "epd_captcha_collect_0004_1781257639422.jpg",
    zones: { siren: [20, 20, 120, 100], keyhole: [150, 20, 250, 100], apple: [350, 20, 450, 100], leaf: [180, 80, 280, 160], doc: [200, 150, 300, 220], compass: [350, 150, 450, 220] },
  },
];

function pct(img, x0, y0, x1, y1) {
  let dark = 0;
  const total = (x1 - x0) * (y1 - y0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (img.bitmap.data[(y * w + x) * 4] < 128) dark++;
    }
  }
  return `${((dark / total) * 100).toFixed(1)}%`;
}

for (const v of imgs) {
  const out = await Jimp.read(path.join(OUT, v.file.replace(".jpg", "") + "_bg.png"));
  console.log(`\n${v.file}`);
  for (const [name, [x0, y0, x1, y1]] of Object.entries(v.zones)) {
    console.log(`  ${name}: ${pct(out, x0, y0, x1, y1)}`);
  }
}
