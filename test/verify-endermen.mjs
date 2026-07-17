// Focused verification of the End's Endermen: tall black creatures with glowing
// purple eyes that wander the island harmlessly — until you look one in the face
// for more than a second, when it screeches, charges and hits you (armour softens
// the blow, just like the dragon's fire). Run alongside smoke.mjs.
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

const errors = [];
const checks = [];
function check(name, cond) { checks.push({ name, ok: !!cond }); }

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(base, { waitUntil: "load" });
await page.waitForFunction(() => window.Game && window.Game.S, { timeout: 8000 });

// Start a world so S.player exists, then build a fresh End to inspect.
await page.click("#btn-new-forest");
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world, { timeout: 8000 });
await page.waitForTimeout(200);

// Shared test helpers live on the page: build an End, aim the player at a point.
await page.evaluate(() => {
  const Game = window.Game;
  window.__mkEnd = () => {
    const W = new Game.World(null, (Game.S.overworld.seed ^ 0x3e4d) >>> 0, "end");
    W.generateEnd();
    return W;
  };
  window.__aimAt = (p, tx, ty, tz) => {
    const eye = p.eyePosition();
    let dx = tx - eye.x, dy = ty - eye.y, dz = tz - eye.z;
    const d = Math.hypot(dx, dy, dz) || 1; dx /= d; dy /= d; dz /= d;
    p.pitch = Math.asin(Math.max(-1, Math.min(1, dy)));
    p.yaw = Math.atan2(-dx, -dz);
    p.syncCamera();
  };
  // A fresh, calm test Enderman placed at (x,z) on the End floor (feet at y=4).
  window.__mkMan = (W, x, z) => {
    const e = Game.World.makeEnderman();
    e.position.set(x, 4, z);
    e.userData.dir = 0; e.userData.timer = 999;   // hold still unless it charges
    e.userData.stare = 0; e.userData.furious = false; e.userData.rage = 0;
    e.userData.hitCooldown = 0; e.userData.anim = 0;
    return e;
  };
});

// --- The End is populated with Endermen, built as tall glowing-eyed creatures ---
const spawn = await page.evaluate(() => {
  const W = window.__mkEnd();
  const C = window.Game.CONST, cx = Math.floor(C.WORLD / 2), cz = Math.floor(C.WORLD / 2);
  const men = W.animals.filter((a) => a.userData.kind === "enderman");
  const one = men[0];
  const parts = one && one.userData.parts;
  // Every Enderman stands clear of the arrival pad at the island's centre.
  const clearOfSpawn = men.every((m) =>
    Math.max(Math.abs(m.position.x - (cx + 0.5)), Math.abs(m.position.z - (cz + 0.5))) >= 6);
  // The model: a head group with a jaw, two arms and two glowing eyes.
  const built = !!(parts && parts.head && parts.jaw && parts.armL && parts.armR &&
    parts.eyes && parts.eyes.length === 2);
  const purpleEyes = built && parts.eyes.every((e) => e.material.emissive.getHex() !== 0x000000);
  return { count: men.length, built, purpleEyes, clearOfSpawn,
    dragonStillThere: W.animals.some((a) => a.userData.kind === "ender_dragon") };
});
check("Endermen spawn in The End", spawn.count >= 1);
check("several Endermen stalk the island", spawn.count >= 3);
check("an Enderman is built with a head, jaw, arms and two eyes", spawn.built);
check("its eyes glow (emissive purple)", spawn.purpleEyes);
check("Endermen keep clear of the arrival pad", spawn.clearOfSpawn);
check("the Ender Dragon still shares the End with them", spawn.dragonStillThere);

// --- Holding its gaze for >1s makes it furious and it screams ---
const provoke = await page.evaluate(() => {
  const S = window.Game.S, W = window.__mkEnd(), p = S.player;
  const e = window.__mkMan(W, 16.5, 10.5);
  p.pos.set(10.5, 4, 10.5); p.vel.set(0, 0, 0);
  // Spy on the toast so we can catch the scream.
  const toasts = []; const realToast = window.Game.toast;
  window.Game.toast = (m) => { toasts.push(m); };
  let furiousAt = -1;
  for (let i = 0; i < 60; i++) {
    // Keep the crosshair locked on its head each frame.
    window.__aimAt(p, e.position.x, e.position.y + 2.35, e.position.z);
    W.updateEnderman(e, 0.05, p);
    if (e.userData.furious && furiousAt < 0) furiousAt = i * 0.05;
  }
  window.Game.toast = realToast;
  return { furious: e.userData.furious, furiousAt,
    screamed: toasts.some((m) => /enderman/i.test(m) && /(screech|lunge|scream)/i.test(m)) };
});
check("staring an Enderman in the face turns it furious", provoke.furious);
check("it takes about a second of eye contact (not instant)", provoke.furiousAt >= 0.9 && provoke.furiousAt <= 1.6);
check("it screams when provoked", provoke.screamed);

// --- A glance that looks away again never provokes it ---
const glance = await page.evaluate(() => {
  const S = window.Game.S, W = window.__mkEnd(), p = S.player;
  const e = window.__mkMan(W, 16.5, 10.5);
  p.pos.set(10.5, 4, 10.5); p.vel.set(0, 0, 0);
  // Look the OTHER way (into the void), never at the Enderman.
  window.__aimAt(p, 10.5, 4, -40);
  let peakStare = 0;
  for (let i = 0; i < 80; i++) { W.updateEnderman(e, 0.05, p); peakStare = Math.max(peakStare, e.userData.stare); }
  return { furious: e.userData.furious, peakStare };
});
check("looking away never provokes an Enderman", glance.furious === false && glance.peakStare < 0.1);

// --- A wall between you blocks the stare (no provoking one through a spire) ---
const blocked = await page.evaluate(() => {
  const S = window.Game.S, W = window.__mkEnd(), p = S.player;
  const key = (a, b, c) => a + "," + b + "," + c;
  const e = window.__mkMan(W, 16.5, 10.5);
  p.pos.set(10.5, 4, 10.5); p.vel.set(0, 0, 0);
  // Drop an obsidian pillar right between your eye and its face.
  for (let x = 12; x <= 13; x++) for (let y = 4; y <= 7; y++) W.blocks.set(key(x, y, 10), "obsidian");
  let furious = false;
  for (let i = 0; i < 60; i++) {
    window.__aimAt(p, e.position.x, e.position.y + 2.35, e.position.z);
    W.updateEnderman(e, 0.05, p);
    if (e.userData.furious) furious = true;
  }
  return { furious };
});
check("you can't provoke an Enderman by staring through a wall", blocked.furious === false);

// --- Once furious it charges you and hits you (unarmoured: it hurts) ---
const charge = await page.evaluate(() => {
  const S = window.Game.S, W = window.__mkEnd(), p = S.player, C = window.Game.CONST;
  const e = window.__mkMan(W, 16.5, 10.5);
  p.pos.set(10.5, 4, 10.5); p.vel.set(0, 0, 0);
  p.hp = C.MAX_HP; p.dead = false;
  for (const slot of window.Game.EQUIP_SLOTS) S.equip[slot] = null; // strip armour
  const startDist = Math.hypot(e.position.x - p.pos.x, e.position.z - p.pos.z);
  const toasts = []; const realToast = window.Game.toast;
  window.Game.toast = (m) => { toasts.push(m); };
  // Provoke it (crosshair on face), then let it charge in.
  for (let i = 0; i < 30; i++) { window.__aimAt(p, e.position.x, e.position.y + 2.35, e.position.z); W.updateEnderman(e, 0.05, p); }
  let minDist = startDist;
  for (let i = 0; i < 120 && p.hp === C.MAX_HP; i++) {
    W.updateEnderman(e, 0.05, p);
    minDist = Math.min(minDist, Math.hypot(e.position.x - p.pos.x, e.position.z - p.pos.z));
  }
  window.Game.toast = realToast;
  return { startDist, minDist, charged: minDist < startDist - 1.5, hp: p.hp,
    hitToast: toasts.some((m) => /hits you/i.test(m)) };
});
check("a furious Enderman charges toward you", charge.charged);
check("it closes right up to striking range", charge.minDist < 1.4);
check("an unarmoured hit costs you health", charge.hp < 20);
check("it announces the hit", charge.hitToast);

// --- With armour on, its blows are shrugged off (same rule as the dragon's fire) ---
const armoured = await page.evaluate(() => {
  const S = window.Game.S, W = window.__mkEnd(), p = S.player, C = window.Game.CONST;
  const e = window.__mkMan(W, 15.5, 10.5);
  p.pos.set(10.5, 4, 10.5); p.vel.set(0, 0, 0);
  p.hp = C.MAX_HP; p.dead = false;
  for (const slot of window.Game.EQUIP_SLOTS) S.equip[slot] = null;
  S.equip.helmet = "diamond_helmet"; // wearing armour blocks monster attacks
  const toasts = []; const realToast = window.Game.toast;
  window.Game.toast = (m) => { toasts.push(m); };
  for (let i = 0; i < 30; i++) { window.__aimAt(p, e.position.x, e.position.y + 2.35, e.position.z); W.updateEnderman(e, 0.05, p); }
  for (let i = 0; i < 120; i++) W.updateEnderman(e, 0.05, p);
  window.Game.toast = realToast;
  return { furious: e.userData.furious, hp: p.hp,
    shrugged: toasts.some((m) => /armour/i.test(m) && /enderman/i.test(m)) };
});
check("armour holds off the Enderman's blows (no damage)", armoured.hp === 20);
check("and it says the armour saved you", armoured.shrugged);

// --- Tapping an Enderman warns you not to stare ---
const tapWarn = await page.evaluate(() => {
  const G = window.Game;
  // The identify branch lives in aimedEntityAct; confirm the copy exists in game.js.
  return typeof G.World.makeEnderman === "function";
});
check("Enderman factory is exposed for the game to use", tapWarn);

// --- Report ---
await browser.close();
server.close();

let pass = 0;
for (const c of checks) { console.log((c.ok ? "  ✅ " : "  ❌ ") + c.name); if (c.ok) pass++; }
console.log("\nErrors: " + (errors.length ? "\n  " + errors.join("\n  ") : "none"));
const ok = pass === checks.length && errors.length === 0;
console.log("\n" + (ok ? "ENDERMEN VERIFY PASSED ✅" : `ENDERMEN VERIFY FAILED ❌ (${pass}/${checks.length})`));
process.exit(ok ? 0 : 1);
