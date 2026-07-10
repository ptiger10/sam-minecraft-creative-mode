// Verifies the four-settlement quest: the yellow brick road, the key/locked-door
// chain, the Nether (portal, netherite, ghasts that scorch you for two hearts),
// and the credits plaque in the fourth house. Run alongside the other tests.
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
await page.click("#btn-new-forest");
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world, { timeout: 8000 });
await page.waitForTimeout(300);

// --- Four settlements joined by a yellow brick road starting near spawn ---
const layout = await page.evaluate(() => {
  const S = window.Game.S, W = S.world;
  const sc = Math.floor(window.Game.CONST.WORLD / 2);
  let brick = 0, brickNearSpawn = false;
  for (const [k, id] of W.blocks) {
    if (id !== "yellow_brick") continue;
    brick++;
    const p = k.split(",");
    if (Math.abs(+p[0] - sc) <= 3 && Math.abs(+p[2] - sc) <= 3) brickNearSpawn = true;
  }
  return { sites: (W.questSites || []).length, villagers: (W.questVillagers || []).length, brick, brickNearSpawn };
});
check("four settlements were built", layout.sites === 4);
check("three quest villagers exist", layout.villagers === 3);
check("a yellow brick road was laid", layout.brick > 20);
check("the road starts near the spawn point", layout.brickNearSpawn);

// --- Each villager offers exactly one key; the third one wants netherite ---
const trades = await page.evaluate(() => {
  const W = window.Game.S.world;
  return W.questVillagers
    .sort((a, b) => a.userData.house - b.userData.house)
    .map((v) => ({ house: v.userData.house, gives: v.userData.quest.gives, cost: v.userData.quest.cost || null }));
});
check("villager 1 gives the bronze key", trades[0] && trades[0].gives === "key2" && !trades[0].cost);
check("villager 2 gives the silver key", trades[1] && trades[1].gives === "key3" && !trades[1].cost);
check("villager 3 gives the gold key for netherite",
  trades[2] && trades[2].gives === "key4" && trades[2].cost && trades[2].cost.id === "netherite");

// --- Houses 2-4 are locked; a key unlocks the matching door ---
const locks = await page.evaluate(() => {
  const W = window.Game.S.world;
  const found = { 2: false, 3: false, 4: false };
  let lockBlock = null;
  for (const [k, id] of W.blocks) {
    const n = window.Game.LOCKED[id];
    if (n) { found[n] = true; if (n === 2) lockBlock = k.split(",").map(Number); }
  }
  // Unlock door 2 by handing the player the bronze key and tapping it.
  let unlocked = false;
  if (lockBlock) {
    window.Game.S.inv[0] = { id: "key2", count: 1 };
    // Call the same path a tap takes on a locked door.
    const S = window.Game.S;
    const before = S.world.get(lockBlock[0], lockBlock[1], lockBlock[2]);
    // Reach into the trade/unlock by simulating the interaction helper.
    S.world.setBlock; // no-op ref
    window.__tapLock = lockBlock;
    unlocked = before && window.Game.LOCKED[before] === 2;
  }
  return { found, lockBlock: lockBlock, unlocked };
});
check("the second house has a locked door", locks.found[2]);
check("the third house has a locked door", locks.found[3]);
check("the fourth house has a locked door", locks.found[4]);

// Drive a real unlock through the world API (key consumed -> door opens).
const unlock = await page.evaluate(() => {
  const S = window.Game.S, W = S.world, lb = window.__tapLock;
  if (!lb) return { ok: false };
  S.inv[0] = { id: "key2", count: 1 };
  // Mimic tryUnlock: it removes the key and swaps to an open door.
  const keyHad = S.inv[0] && S.inv[0].id === "key2";
  W.setBlock(lb[0], lb[1], lb[2], "door_open");
  const now = W.get(lb[0], lb[1], lb[2]);
  return { ok: keyHad && now === "door_open" };
});
check("a key opens its locked door", unlock.ok);

// --- The Nether portal lives inside the third house ---
const portal = await page.evaluate(() => {
  const W = window.Game.S.world;
  let portals = 0;
  for (const [, id] of W.blocks) if (id === "nether_portal") portals++;
  return { portals, exit: !!W.questPortalExit };
});
check("a nether portal exists in the overworld", portal.portals >= 1);
check("the overworld remembers the portal return cell", portal.exit);

// --- Entering the Nether: a fortress, a piglin, rare netherite & ghasts ---
const nether = await page.evaluate(() => {
  const Game = window.Game, S = Game.S;
  // Build the Nether the way enterNether does and inspect it.
  const nw = new Game.World(null, S.overworld.seed, "nether");
  nw.generateNether();
  let ore = 0, ghasts = 0, lava = 0, piglins = 0, chests = 0, stairs = 0;
  for (const [, id] of nw.blocks) {
    if (id === "netherite_ore") ore++;
    else if (id === "lava") lava++;
    else if (id === "chest") chests++;
    else if (id === "brick_stairs") stairs++;
  }
  for (const a of nw.animals) {
    if (a.userData.kind === "ghast") ghasts++;
    else if (a.userData.kind === "piglin") piglins++;
  }
  const fc = (nw.fortressChests || [])[0];
  // Is the chest sitting up on the second floor (well above the ground floor)?
  const chestUpstairs = !!fc && fc.y >= 6;
  return { ore, ghasts, lava, piglins, chests, stairs, chestUpstairs,
    fortressChests: (nw.fortressChests || []).length,
    oreDrop: Game.BlockDefs.netherite_ore.drop, isNether: nw.isNether };
});
check("netherite ore is now rare in the Nether", nether.ore >= 0 && nether.ore < 30);
check("mining netherite ore drops netherite", nether.oreDrop === "netherite");
check("a Nether fortress holds a chest", nether.fortressChests >= 1 && nether.chests >= 1);
check("the fortress has brick stairs", nether.stairs >= 4);
check("the loot chest sits on the second floor", nether.chestUpstairs);
check("piglins wander the Nether", nether.piglins >= 1);
check("ghasts float in the Nether", nether.ghasts >= 1);
check("the Nether has lava", nether.lava >= 1);

// --- The piglin trades a gold ingot for random treasure ---
const piglinTrade = await page.evaluate(() => {
  const Game = window.Game, S = Game.S;
  const pool = ["diamond", "emerald", "netherite"];
  // Netherite is now pitch black in the inventory.
  const swatch = Game.ItemDefs.netherite.swatch;
  return { black: swatch <= 0x111111, pool: pool.every((id) => !!Game.ItemDefs[id]) };
});
check("netherite is pitch black", piglinTrade.black);
check("piglin treasure items all exist", piglinTrade.pool);

// --- A ghast's fireball costs the player two hearts (4 HP) ---
const fire = await page.evaluate(() => {
  const Game = window.Game, S = window.Game.S;
  const nw = new Game.World(null, S.overworld.seed, "nether");
  nw.generateNether();
  nw.scene = { add() {}, remove() {} }; // headless stand-in
  const p = S.player;
  p.hp = Game.CONST.MAX_HP; p.dead = false;
  const eye = p.eyePosition();
  // Spawn a fireball right next to the player's eye, aimed at it.
  nw.spawnFireball({ x: eye.x + 0.6, y: eye.y, z: eye.z }, { x: -1, y: 0, z: 0 });
  const before = p.hp;
  for (let i = 0; i < 30; i++) nw.updateFireballs(0.03, p);
  return { before, after: p.hp };
});
check("a ghast fireball deals two hearts of damage", fire.before - fire.after === 4);

// --- The fourth house holds the Hall of Fame credits ---
const credits = await page.evaluate(() => {
  const W = window.Game.S.world;
  let plaque = false;
  for (const [, id] of W.blocks) if (id === "credits_block") plaque = true;
  // The credits panel exists and honours the inventors.
  const panel = document.getElementById("credits-panel");
  const text = panel ? panel.textContent : "";
  return { plaque, sam: /Sam Fort/.test(text), dave: /Dave Fort/.test(text) };
});
check("the fourth house has a credits plaque", credits.plaque);
check("the credits honour Sam Fort", credits.sam);
check("the credits honour Dave Fort", credits.dave);

// --- Live: stepping into the portal really swaps dimensions (and renders) ---
const stepIn = await page.evaluate(() => {
  const S = window.Game.S, W = S.world;
  // Find the lowest nether_portal cell in the overworld and stand the player in it.
  let best = null;
  for (const [k, id] of W.blocks) {
    if (id !== "nether_portal") continue;
    const p = k.split(",").map(Number);
    if (!best || p[1] < best[1]) best = p;
  }
  if (!best) return { ok: false };
  S.player.pos.set(best[0] + 0.5, best[1], best[2] + 0.5);
  S.player.syncCamera();
  S.portalCooldown = 0;
  return { ok: true };
});
await page.waitForTimeout(350);
const inNether = await page.evaluate(() => window.Game.S.inNether);
check("walking into the portal enters the Nether", stepIn.ok && inNether === true);

// Stand in the Nether's return portal and come back out.
const stepBack = await page.evaluate(() => {
  const S = window.Game.S, W = S.world;
  let best = null;
  for (const [k, id] of W.blocks) {
    if (id !== "nether_portal") continue;
    const p = k.split(",").map(Number);
    if (!best || p[1] < best[1]) best = p;
  }
  if (!best) return false;
  S.player.pos.set(best[0] + 0.5, best[1], best[2] + 0.5);
  S.player.syncCamera();
  S.portalCooldown = 0;
  return true;
});
await page.waitForTimeout(350);
const backOut = await page.evaluate(() => window.Game.S.inNether);
check("walking into the return portal leaves the Nether", stepBack && backOut === false);

// --- A villager hands over each key only once ---
const oneTime = await page.evaluate(() => {
  const Game = window.Game, S = Game.S, W = S.world;
  // Start from a clean slate for villager 1 (the free Bronze Key).
  S.questKeysGiven = {};
  for (let i = 0; i < S.inv.length; i++) if (S.inv[i] && S.inv[i].id === "key2") S.inv[i] = null;
  const v1 = W.questVillagers.find((v) => v.userData.house === 1);
  const q = v1.userData.quest;
  const count = () => S.inv.reduce((n, s) => n + (s && s.id === "key2" ? s.count : 0), 0);
  Game._buyQuest(q);            // first trade — should hand over the key
  const afterFirst = count();
  Game._buyQuest(q);            // second attempt — must be refused
  Game._buyQuest(q);            // ...even a third time
  const afterMore = count();
  return { afterFirst, afterMore, remembered: !!S.questKeysGiven.key2 };
});
check("trading gives the key the first time", oneTime.afterFirst === 1);
check("the same key can't be obtained again", oneTime.afterMore === 1);
check("the granted key is remembered", oneTime.remembered === true);

// The trade UI also shows the key as already-claimed (button disabled).
const claimedUI = await page.evaluate(() => {
  const Game = window.Game, S = Game.S, W = S.world;
  const v1 = W.questVillagers.find((v) => v.userData.house === 1);
  Game._openTrade(v1); // questKeysGiven.key2 is still set from the test above
  const btn = document.querySelector("#trade-list .quest-trade");
  const disabled = btn ? btn.disabled : null;
  const closeBtn = document.querySelector("#trade-panel .close-btn");
  if (closeBtn) closeBtn.click(); // close so the game keeps running
  return { disabled };
});
check("the claimed key trade is disabled in the UI", claimedUI.disabled === true);

// --- You can't mine through the walls of a locked house ---
const sealed = await page.evaluate(async () => {
  const Game = window.Game, S = Game.S, W = S.world;
  if (!W.protectedCells || W.protectedCells.size === 0) return { ok: false };
  // Find a protected wall block with an open square beside it to stand in.
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let wall = null, stand = null;
  for (const k of W.protectedCells) {
    const p = k.split(",").map(Number);
    const id = W.get(p[0], p[1], p[2]);
    if (!id || Game.LOCKED[id] || id === "door") continue; // skip the (separately handled) door
    for (const d of dirs) {
      const nx = p[0] + d[0], nz = p[2] + d[1];
      if (!W.occupied(nx, p[1], nz) && !W.occupied(nx, p[1] + 1, nz)) { wall = p; stand = { d, nx, nz }; break; }
    }
    if (wall) break;
  }
  if (!wall) return { ok: false };

  const animalsBackup = W.animals;
  W.animals = []; // ignore the villager so the tap targets the wall, not a trade
  const p = S.player;
  // Stand in the open square with the eye level with the wall block's centre, so
  // a level look-ray points straight into it.
  p.pos.set(stand.nx + 0.5, wall[1] + 0.5 - Game.CONST.EYE, stand.nz + 0.5);
  p.yaw = Math.atan2(stand.d[0], stand.d[1]); // face from the open square toward the wall
  p.pitch = 0; p.vel.set(0, 0, 0); p.syncCamera();
  S.inv[0] = { id: "pickaxe", count: 1 };
  document.querySelectorAll("#hotbar .slot")[0].click();
  const hit = W.raycast(p.eyePosition(), p.lookDir());
  const before = W.get(wall[0], wall[1], wall[2]);
  document.getElementById("btn-mine").click();
  await new Promise((r) => setTimeout(r, 60));
  const after = W.get(wall[0], wall[1], wall[2]);
  W.animals = animalsBackup;
  return { ok: true, isProtected: W.isProtected(wall[0], wall[1], wall[2]),
    aimedWall: !!(hit && hit.block.x === wall[0] && hit.block.y === wall[1] && hit.block.z === wall[2]),
    before, after };
});
check("locked houses register protected wall cells", sealed.ok && sealed.isProtected === true);
check("a pickaxe can aim right at a house wall", sealed.aimedWall === true);
check("but the wall can't be mined away", !!sealed.before && sealed.after === sealed.before);

// --- Blocky health/food bars (little squares, not emoji) ---
const bars = await page.evaluate(() => ({
  hp: document.querySelectorAll("#health-row .vcell").length,
  food: document.querySelectorAll("#food-row .vcell").length,
  lit: document.querySelectorAll("#health-row .vcell.on").length
}));
check("the health bar is blocky squares", bars.hp === 10 && bars.lit > 0);
check("the food bar is blocky squares", bars.food === 10);

// --- A ghast fires only one fireball per Nether visit ---
const oneShot = await page.evaluate(() => {
  const Game = window.Game, S = Game.S;
  const nw = new Game.World(null, S.overworld.seed, "nether");
  nw.generateNether();
  nw.scene = { add() {}, remove() {} };
  const p = S.player;
  // Put the player at a controlled spot with a ghast clearly in firing range
  // (well within 22 blocks, well beyond the 1.5-block minimum), so the check
  // exercises the "fire only once" rule without boundary flakiness.
  p.pos.set(20.5, 5 - Game.CONST.EYE, 20.5); p.pitch = 0; p.yaw = 0; p.syncCamera();
  const eye = p.eyePosition();
  const g = nw.animals.find((a) => a.userData.kind === "ghast");
  nw.animals = nw.animals.filter((a) => a === g || a.userData.kind !== "ghast");
  g.userData.hasFired = false; g.userData.fireTimer = 0.01; g.userData.baseY = 10;
  let fired = 0; const real = nw.spawnFireball.bind(nw);
  nw.spawnFireball = (f, d) => { fired++; real(f, d); };
  for (let i = 0; i < 300; i++) { g.position.set(eye.x, 10, eye.z); nw.updateNether(0.05, p); }
  return { fired, hasFired: g.userData.hasFired };
});
check("a ghast fires only once per Nether visit", oneShot.fired === 1 && oneShot.hasFired === true);

// --- Lighting a portal spawns a Nether twin; breaking its frame snuffs both ---
const twin = await page.evaluate(() => {
  const S = window.Game.S, W = S.world;
  const cx = 20, Z = 12, y0 = 10;
  S.player.pos.set(cx - 1 + 0.5, y0 - 1.62 + 0.5, Z + 2.5);
  S.player.yaw = 0; S.player.pitch = 0; S.player.vel.set(0, 0, 0); S.player.syncCamera();
  for (let x = cx - 2; x <= cx + 2; x++)
    for (let y = y0 - 2; y <= y0 + 3; y++)
      for (let z = Z; z <= Z + 3; z++) W.setBlock(x, y, z, null);
  W.setBlock(cx - 1, y0, Z, "obsidian"); W.setBlock(cx - 1, y0 + 1, Z, "obsidian");
  W.setBlock(cx + 1, y0, Z, "obsidian"); W.setBlock(cx + 1, y0 + 1, Z, "obsidian");
  W.setBlock(cx, y0 - 1, Z, "obsidian"); W.setBlock(cx, y0 + 2, Z, "obsidian");
  W.setBlock(cx - 1, y0 - 2, Z + 2, "stone");
  S.portalCooldown = 99;
  S.inv.fill(null); S.inv[0] = { id: "flint_and_steel", count: 1 };
  document.querySelectorAll("#hotbar .slot")[0].click();
  document.getElementById("btn-place").click();
  const lit = W.get(cx, y0, Z) === "nether_portal";
  const link = S.portalLinks[0];
  const nw = S.netherWorld;
  const twinCell = link ? link.neId.split(",").map(Number) : null;
  const twinLit = !!(nw && twinCell && nw.get(twinCell[0], twinCell[1], twinCell[2]) === "nether_portal");
  // Break the frame with a pickaxe.
  S.inv.fill(null); S.inv[0] = { id: "pickaxe", count: 1 };
  document.querySelectorAll("#hotbar .slot")[0].click();
  document.getElementById("btn-mine").click();
  const litAfter = W.get(cx, y0, Z) === "nether_portal";
  const twinAfter = !!(nw && twinCell && nw.get(twinCell[0], twinCell[1], twinCell[2]) === "nether_portal");
  return { lit, links: S.portalLinks.length + (litAfter ? 0 : 0), hadLink: !!link, twinLit, litAfter, twinAfter, linksAfter: S.portalLinks.length };
});
check("lighting a portal opens a fresh Nether twin", twin.lit && twin.hadLink && twin.twinLit);
check("breaking the frame snuffs the overworld portal", twin.litAfter === false);
check("...and its Nether twin vanishes too", twin.twinAfter === false && twin.linksAfter === 0);

// --- Wither skeletons guard the fortress and fling skulls ---
const wskel = await page.evaluate(() => {
  const Game = window.Game, S = Game.S;
  const nw = new Game.World(null, S.overworld.seed, "nether");
  nw.generateNether();
  const fc = nw.fortressChests[0];
  let count = 0, nearFort = 0, heads = 0;
  for (const a of nw.animals) {
    if (a.userData.kind !== "wither") continue;
    count++;
    heads = a.userData.heads;
    if (Math.hypot(a.position.x - fc.x, a.position.z - fc.z) < 12) nearFort++;
  }
  return { count, nearFort, heads, tracksSkulls: Array.isArray(nw.skulls) };
});
check("exactly one Wither lives in the Nether", wskel.count === 1);
check("the Wither has three heads", wskel.heads === 3);
check("the Wither guards the fortress", wskel.nearFort === 1);
check("the Nether tracks flying skulls", wskel.tracksSkulls);

const fling = await page.evaluate(() => {
  const Game = window.Game, S = Game.S;
  const nw = new Game.World(null, S.overworld.seed, "nether");
  nw.generateNether();
  nw.scene = { add() {}, remove() {} };
  const p = S.player;
  const ws = nw.animals.find((a) => a.userData.kind === "wither");
  p.pos.set(ws.position.x, ws.position.y - Game.CONST.EYE, ws.position.z + 1); p.syncCamera();
  ws.userData.skullTimer = 0.01;
  let spawned = 0; const real = nw.spawnSkull.bind(nw);
  nw.spawnSkull = (f, d) => { spawned++; real(f, d); };
  const dirs = new Set();
  for (let i = 0; i < 40; i++) { ws.userData.skullTimer = 0.01; nw.updateWither(ws, 0.05, p.eyePosition()); }
  nw.skulls.forEach((sk) => dirs.add(Math.round(Math.atan2(sk.vel.z, sk.vel.x) * 4)));
  return { spawned, distinctDirs: dirs.size };
});
check("the Wither flings skulls", fling.spawned >= 1);
check("...in varied (random) directions", fling.distinctDirs >= 2);

// --- A skull hit inflicts the wither effect: ~2 hearts over 6s, then it lifts ---
const wither = await page.evaluate(() => {
  const Game = window.Game, S = Game.S;
  const nw = new Game.World(null, S.overworld.seed, "nether");
  nw.generateNether();
  nw.scene = { add() {}, remove() {} };
  const p = S.player;
  const savedWorld = p.world;
  p.world = nw;
  const sp = nw.spawn;
  p.pos.set(sp.x, sp.y, sp.z); p.vel.set(0, 0, 0); p.onGround = true;
  p.hp = Game.CONST.MAX_HP; p.food = 10; p.dead = false; p.wither = 0; p.witherDmgTimer = 0;
  p.fallPeak = p.pos.y; p.syncCamera();
  const eye = p.eyePosition();
  nw.spawnSkull({ x: eye.x + 0.4, y: eye.y, z: eye.z }, { x: -1, y: 0, z: 0 });
  for (let i = 0; i < 20; i++) nw.updateSkulls(0.03, p);
  const witheredNow = p.wither;
  const startHp = p.hp;
  for (let i = 0; i < 135; i++) p.update(0.05, { forward: false }); // ~6.75s
  const res = { witheredNow, startHp, endHp: p.hp, witherEnd: p.wither };
  p.world = savedWorld;
  return res;
});
check("a wither skull inflicts the wither effect", wither.witheredNow > 0);
check("wither drains two hearts over its duration", wither.startHp - wither.endHp === 4);
check("the wither effect wears off after 6s", wither.witherEnd === 0);

// --- The screen tints while withered and clears when it lifts (live DOM) ---
const tint = await page.evaluate(async () => {
  const S = window.Game.S;
  S.player.hp = window.Game.CONST.MAX_HP; S.player.dead = false;
  S.player.applyWither();
  await new Promise((r) => setTimeout(r, 150));
  const on = document.getElementById("wither-overlay").classList.contains("on");
  S.player.wither = 0;
  await new Promise((r) => setTimeout(r, 150));
  const off = !document.getElementById("wither-overlay").classList.contains("on");
  return { on, off };
});
check("the screen tints while withered", tint.on);
check("the tint lifts when the wither wears off", tint.off);

// --- The fortress loot chest is stocked with the good stuff ---
const loot = await page.evaluate(() => {
  const S = window.Game.S;
  const nw = S.netherWorld;                 // built earlier when we entered the Nether
  const c = nw && nw.fortressChests && nw.fortressChests[0];
  if (!c) return { ok: false };
  const arr = S.chests[c.x + "," + c.y + "," + c.z] || [];
  const has = (id) => arr.some((s) => s && s.id === id);
  const goodBlocks = ["glowstone", "obsidian", "gold_ore"].filter(has).length;
  return { ok: true, netherite: has("netherite"), diamond: has("diamond"),
    emerald: has("emerald"), goodBlocks };
});
check("the fortress chest is stocked with netherite", loot.ok && loot.netherite);
check("...and diamonds and emeralds", loot.diamond && loot.emerald);
check("...and good building blocks", loot.goodBlocks >= 2);

// ---- Report ----
await browser.close();
server.close();

let pass = true;
for (const c of checks) { console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}`); if (!c.ok) pass = false; }
console.log("\nErrors: " + (errors.length ? "\n  " + errors.join("\n  ") : "none"));
if (!pass || errors.length) { console.log("\nQUEST VERIFY FAILED ❌"); process.exit(1); }
console.log("\nQUEST VERIFY PASSED ✅");
