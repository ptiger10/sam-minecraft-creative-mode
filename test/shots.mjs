// Quick visual screenshots of the new furnace decoration, stairs, and the
// tall villager settlement. Writes PNGs into test/.
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join, normalize } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { chromium } = require(join(process.env.PW_ROOT, "playwright"));
const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto(base, { waitUntil: "load" });
await page.waitForFunction(() => window.Game && window.Game.S, { timeout: 8000 });
await page.click("#btn-new-expanded");
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world, { timeout: 8000 });
await page.waitForTimeout(300);

// 1) Furnace + stairs right in front of the player.
await page.evaluate(() => {
  const S = window.Game.S, W = S.world, p = S.player;
  const key = (x, y, z) => x + "," + y + "," + z;
  p.yaw = 0; p.pitch = -0.2; p.vel.set(0, 0, 0); p.syncCamera();
  const px = Math.floor(p.pos.x), pz = Math.floor(p.pos.z), gy = Math.floor(p.pos.y);
  for (let dz = 1; dz <= 6; dz++) for (let dx = -3; dx <= 3; dx++) for (let dy = 0; dy <= 4; dy++) W.blocks.delete(key(px + dx, gy + dy, pz - dz));
  for (let dz = 1; dz <= 6; dz++) for (let dx = -3; dx <= 3; dx++) W.blocks.set(key(px + dx, gy - 1, pz - dz), "grass");
  W.blocks.set(key(px - 1, gy, pz - 3), "furnace");
  // a little flight of stairs
  W.blocks.set(key(px + 1, gy, pz - 3), "stairs");
  W.blocks.set(key(px + 1, gy + 1, pz - 4), "stairs");
  W.blocks.set(key(px + 1, gy + 2, pz - 5), "stairs");
  W.buildMeshes();
});
await page.waitForTimeout(200);
await page.screenshot({ path: join(ROOT, "test/shot-furnace-stairs.png") });

// 2) Look down on the villager settlement from high above.
await page.evaluate(() => {
  const S = window.Game.S, W = S.world, p = S.player;
  const v = W.animals.find((a) => a.userData.kind === "villager");
  if (!v) return;
  const hx = v.userData.home.x, hz = v.userData.home.z;
  p.pos.set(hx + 11, 30, hz + 11);
  // forwardH = (-sin yaw, 0, -cos yaw); aim it from the player toward the village.
  p.yaw = Math.atan2(-(hx - p.pos.x), -(hz - p.pos.z));
  p.pitch = -0.55;
  p.syncCamera();
});
await page.waitForTimeout(200);
await page.screenshot({ path: join(ROOT, "test/shot-settlement.png") });

await browser.close();
server.close();
console.log("wrote test/shot-furnace-stairs.png and test/shot-settlement.png");
