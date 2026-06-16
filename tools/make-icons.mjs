// Generates the app icons from a single SVG source. Renders an isometric
// grass-dirt block (the game's signature look) on a sky background at the
// sizes iOS / Android want for "Add to Home Screen".
//
//   PW_ROOT="$(npm root -g)" node tools/make-icons.mjs
//
// Writes media/icon.svg (editable source) + icons/*.png (committed so the
// game works without re-running this). Needs Playwright + chromium.
import { createRequire } from "module";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const require = createRequire(import.meta.url);
const { chromium } = require(join(process.env.PW_ROOT, "playwright"));
const ROOT = new URL("..", import.meta.url).pathname;

// Isometric cube. Top diamond centred at (256,170); side faces drop 150px.
const SVG = `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#87ceeb"/>
  <!-- left face (dirt, in shadow) -->
  <polygon points="106,170 256,248 256,398 106,320" fill="#6b4a2a"/>
  <!-- right face (dirt, lit) -->
  <polygon points="406,170 256,248 256,398 406,320" fill="#855e36"/>
  <!-- grass overhang on the two side faces -->
  <polygon points="106,170 256,248 256,274 106,196" fill="#4f9a36"/>
  <polygon points="406,170 256,248 256,274 406,196" fill="#5cae3f"/>
  <!-- top face (grass) -->
  <polygon points="256,92 406,170 256,248 106,170" fill="#6abe46"/>
</svg>`;

await writeFile(join(ROOT, "media/icon.svg"), SVG + "\n");
await mkdir(join(ROOT, "icons"), { recursive: true });

const sizes = [
  ["icons/apple-touch-icon.png", 180],
  ["icons/icon-192.png", 192],
  ["icons/icon-512.png", 512]
];

const browser = await chromium.launch({ args: ["--no-sandbox"] });
for (const [out, s] of sizes) {
  const page = await browser.newPage({ viewport: { width: s, height: s }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0}svg{display:block;width:${s}px;height:${s}px}</style>` +
    SVG
  );
  await page.screenshot({ path: join(ROOT, out) });
  await page.close();
  console.log("wrote", out, `(${s}x${s})`);
}
await browser.close();
console.log("done");
