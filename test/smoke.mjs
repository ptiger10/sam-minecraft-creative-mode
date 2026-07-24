// Headless smoke test: boots the game, starts a world, and exercises the
// real code paths (spawn, movement, crafting, placing, mining, eating)
// through the actual DOM controls. Reports console/runtime errors + a shot.
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

// Simulate a quick tap at the crosshair (centre of the screen) — the same path
// a real player's tap takes through #game's pointer handlers.
function worldTap(page) {
  return page.evaluate(() => {
    const el = document.getElementById("game");
    const o = { clientX: Math.round(innerWidth / 2), clientY: Math.round(innerHeight / 2), bubbles: true };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
  });
}

// Plant a block straight ahead of the player (looking along -Z) with a clear
// path, then hand the player some dirt to hold. Returns where the ray hits.
function aimAt(page, blockId) {
  return page.evaluate((id) => {
    const S = window.Game.S, W = S.world, p = S.player;
    const key = (a, b, c) => a + "," + b + "," + c;
    p.pitch = 0; p.yaw = 0; p.vel.set(0, 0, 0); p.syncCamera();
    const eye = p.eyePosition(), dir = p.lookDir();
    for (let i = 0; i <= 5; i++) {
      W.blocks.delete(key(Math.floor(eye.x + dir.x * i), Math.floor(eye.y + dir.y * i), Math.floor(eye.z + dir.z * i)));
    }
    const bx = Math.floor(eye.x + dir.x * 3), by = Math.floor(eye.y + dir.y * 3), bz = Math.floor(eye.z + dir.z * 3);
    W.blocks.set(key(bx, by, bz), id);
    W.buildMeshes();
    S.inv[0] = { id: "dirt", count: 5 };          // hold a placeable block
    document.querySelectorAll("#hotbar .slot")[0].click();
    const hit = W.raycast(eye, dir);
    const count = (q) => S.inv.reduce((n, s) => n + (s && s.id === q ? s.count : 0), 0);
    return { block: { x: bx, y: by, z: bz }, hit, place: hit ? hit.place : null,
      dirt: count("dirt"), apples: count("apple") };
  }, blockId);
}

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(base, { waitUntil: "load" });
await page.waitForFunction(() => window.Game && window.Game.S, { timeout: 8000 });

// --- Start an expanded world (spawns in the forest) ---
await page.click("#btn-new-expanded");
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world, { timeout: 8000 });
await page.waitForTimeout(400);

const info = await page.evaluate(() => {
  const S = window.Game.S, G = window.Game;
  let melonOnGround = false;
  for (const id of S.world.blocks.values()) { if (id === "watermelon") { melonOnGround = true; break; } }
  return {
    running: S.running, biome: S.world.biome, blockCount: S.world.blocks.size,
    meshTypes: (() => { const t = new Set(); S.world.meshChunks.forEach((m) => Object.keys(m).forEach((id) => t.add(id))); return t.size; })(),
    animals: S.world.animals.length,
    animalKinds: S.world.animals.map((a) => a.userData.kind),
    melonOnGround, melonEdible: !!(G.ItemDefs.watermelon && G.ItemDefs.watermelon.food),
    melonHarvest: G.harvestOnTap("watermelon"),
    hp: S.player.hp, food: S.player.food,
    spawnStuck: S.player.collides(S.player.pos.x, S.player.pos.y, S.player.pos.z)
  };
});
check("world running", info.running);
check("world has many blocks", info.blockCount > 1000);
check("multiple block types rendered", info.meshTypes >= 3);
check("animals spawned", info.animals > 0);
check("monkeys swing in the forest", info.animalKinds.includes("monkey"));
check("ground animals walk around too", info.animalKinds.some((k) => k && k !== "monkey"));
check("watermelons grow on the ground", info.melonOnGround);
check("watermelon is edible", info.melonEdible);
check("watermelon is grabbed on tap", info.melonHarvest);
check("player NOT stuck at spawn", info.spawnStuck === false);
check("full health", info.hp === 20);
check("full food", info.food === 20);

// --- Movement: forward + turn + jump ---
const before = await page.evaluate(() => ({ ...window.Game.S.player.pos }));
await page.evaluate(() => { const S = window.Game.S; S.input.forward = true; S.input.turnRight = true; });
await page.waitForTimeout(400);
await page.evaluate(() => { window.Game.S.input.jump = true; });
await page.waitForTimeout(250);
const after = await page.evaluate(() => {
  const S = window.Game.S; S.input.forward = S.input.turnRight = S.input.jump = false;
  return { ...S.player.pos };
});
check("player moved", Math.abs(after.x - before.x) + Math.abs(after.z - before.z) > 0.1);

// --- Crafting: the Craft button opens a 2x2 grid; make a stick + table ---
await page.evaluate(() => { window.Game.S.inv[0] = { id: "wood", count: 8 }; });
await page.click("#btn-craft");
await page.waitForTimeout(120);
const gridSize = await page.evaluate(() => window.Game.S.craft.size);
check("Craft button opens a 2x2 grid", gridSize === 2);
// Auto-arrange + craft a stick (2 wood), then a crafting table (4 wood).
await page.click('#recipe-book [data-recipe="stick"]');
await page.click("#craft-result");
await page.click('#recipe-book [data-recipe="crafting_table"]');
await page.click("#craft-result");
const craft = await page.evaluate(() => {
  const inv = window.Game.S.inv.filter(Boolean);
  const has = (id) => inv.some((s) => s.id === id);
  const count = (id) => inv.filter((s) => s.id === id).reduce((a, s) => a + s.count, 0);
  const pickBtn = document.querySelector('#recipe-book [data-recipe="pickaxe"]');
  return { stick: has("stick"), table: has("crafting_table"), wood: count("wood"),
    pickaxeDisabledNoTable: pickBtn ? pickBtn.disabled : null };
});
check("crafted a stick", craft.stick);
check("crafted a crafting table", craft.table);
check("wood was consumed (8 - 2 - 4 = 2)", craft.wood === 2);
check("pickaxe needs a table (disabled in 2x2)", craft.pickaxeDisabledNoTable === true);
await page.click("#craft-panel .close-btn");

// --- Placing a block: aim at a clear, known target so this is deterministic
//     (the forest world is randomly seeded, so don't rely on the terrain). ---
const placeResult = await page.evaluate(async () => {
  const S = window.Game.S, W = S.world, p = S.player;
  const key = (a, b, c) => a + "," + b + "," + c;
  p.pitch = 0; p.yaw = 0; p.vel.set(0, 0, 0); p.syncCamera();
  const eye = p.eyePosition(), dir = p.lookDir();
  // Clear a tunnel straight ahead, then drop a solid block 3 out to build on.
  for (let i = 0; i <= 5; i++) {
    W.blocks.delete(key(Math.floor(eye.x + dir.x * i), Math.floor(eye.y + dir.y * i), Math.floor(eye.z + dir.z * i)));
  }
  const bx = Math.floor(eye.x + dir.x * 3), by = Math.floor(eye.y + dir.y * 3), bz = Math.floor(eye.z + dir.z * 3);
  W.blocks.set(key(bx, by, bz), "stone");
  W.buildMeshes();
  S.inv[1] = { id: "dirt", count: 10 };
  document.querySelectorAll("#hotbar .slot")[1].click();
  const changesBefore = W.changes.size;
  document.getElementById("btn-place").click();
  await new Promise((r) => setTimeout(r, 60));
  return { changed: W.changes.size > changesBefore, dirtLeft: S.inv[1] ? S.inv[1].count : 0 };
});
check("placed a block (world changed)", placeResult.changed);
check("a dirt block was consumed", placeResult.dirtLeft === 9);

// --- Mining without a pickaxe on the dirt we just placed (hand-breakable) ---
const mineResult = await page.evaluate(async () => {
  const S = window.Game.S;
  const sizeBefore = S.world.blocks.size;
  document.getElementById("btn-mine").click();
  await new Promise((r) => setTimeout(r, 60));
  return { removed: S.world.blocks.size < sizeBefore };
});
check("mining removed a block", mineResult.removed);

// --- Eating: no apples -> nothing; with apples -> food restored ---
const eat = await page.evaluate(async () => {
  const S = window.Game.S;
  S.player.food = 10;
  S.inv[2] = { id: "apple", count: 2 };
  document.getElementById("btn-eat").click();
  await new Promise((r) => setTimeout(r, 30));
  return { food: S.player.food, applesLeft: S.inv[2] ? S.inv[2].count : 0 };
});
check("eating an apple restored food", eat.food > 10);
check("an apple was consumed", eat.applesLeft === 1);

// --- Watermelon is a placeable block you can also eat ---
const eatMelon = await page.evaluate(async () => {
  const S = window.Game.S;
  S.player.food = 8;
  S.inv[5] = { id: "watermelon", count: 2 };
  document.querySelectorAll("#hotbar .slot")[5].click(); // hold the melon
  document.getElementById("btn-eat").click();
  await new Promise((r) => setTimeout(r, 30));
  return { food: S.player.food, melonLeft: S.inv[5] ? S.inv[5].count : 0 };
});
check("eating a watermelon restored food", eatMelon.food > 8);
check("a watermelon was consumed", eatMelon.melonLeft === 1);

// --- Saving (first save opens the slot picker; choosing a slot binds it) ---
const save = await page.evaluate(async () => {
  document.getElementById("btn-save").click();       // no slot yet -> picker
  await new Promise((r) => setTimeout(r, 50));
  const pickerShown = !document.getElementById("slot-panel").classList.contains("hidden");
  document.getElementById("btn-slot-1").click();     // choose slot 1
  await new Promise((r) => setTimeout(r, 50));
  return { pickerShown,
    saved: !!localStorage.getItem("blocky-world-save-slot1"),
    bound: window.Game.S.saveSlot === 1 };
});
check("first save asks which slot to use", save.pickerShown);
check("game saved to slot 1", save.saved);
check("slot 1 is now the automatic save slot", save.bound);
await page.screenshot({ path: new URL("./screenshot.png", import.meta.url).pathname });

// --- Pickaxe crafting: a Crafting Table opens the full 3x3 grid ---
await page.evaluate(() => {
  const S = window.Game.S;
  S.inv[3] = { id: "stick", count: 2 };
  S.inv[4] = { id: "wood", count: 3 };
  window.Game._openCrafting(true); // same path as tapping a placed crafting table
});
await page.waitForTimeout(120);
const size3 = await page.evaluate(() => window.Game.S.craft.size);
check("a crafting table opens a 3x3 grid", size3 === 3);
await page.click('#recipe-book [data-recipe="pickaxe"]');
await page.click("#craft-result");
const pick = await page.evaluate(() => window.Game.S.inv.some((s) => s && s.id === "pickaxe"));
check("crafted a pickaxe (with table)", pick);
await page.click("#craft-panel .close-btn");

// --- The shaped recipes match the exact grid layouts that were requested ---
const shapes = await page.evaluate(() => {
  const S = window.Game.S, G = window.Game;
  const W = "wood", st = "stick", T = "stone";
  const match = (rows, table) => {
    S.craft.size = 3; S.craft.table = !!table;
    S.craft.grid = rows.flat().map((c) => c || null);
    const r = G._currentRecipe();
    return r ? r.gives.id : null;
  };
  const out = {
    stick: match([[null, W, null], [null, W, null], [null, null, null]], false),
    table: match([[W, W, null], [W, W, null], [null, null, null]], false),
    pickaxe: match([[W, W, W], [null, st, null], [null, st, null]], true),
    stonePick: match([[T, T, T], [null, st, null], [null, st, null]], true),
    ladder: match([[st, null, st], [st, st, st], [st, null, st]], true)
  };
  S.craft.grid = []; // these grids were set directly; don't let close-up re-add items
  return out;
});
check("centre + centre-bottom wood -> 1 stick", shapes.stick === "stick");
check("2x2 wood -> crafting table", shapes.table === "crafting_table");
check("3 wood + 2 sticks -> wooden pickaxe", shapes.pickaxe === "pickaxe");
check("3 stone + 2 sticks -> stone pickaxe", shapes.stonePick === "stone_pickaxe");
check("7 sticks in an H -> ladder", shapes.ladder === "ladder");

// --- Save + load round-trip (forest world is restored) ---
const cBefore = await page.evaluate(() => window.Game.S.world.changes.size);
await page.click("#btn-menu");            // autosaves to the bound slot + opens the title
await page.waitForTimeout(150);
await page.click("#btn-load-1");          // loads slot 1 back
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world.biome === "forest", { timeout: 8000 });
await page.waitForTimeout(200);
const loaded = await page.evaluate(() => {
  const S = window.Game.S;
  return { biome: S.world.biome, changes: S.world.changes.size, hasPickaxe: S.inv.some((s) => s && s.id === "pickaxe") };
});
check("loaded world is a forest", loaded.biome === "forest");
check("loaded world kept its edits", loaded.changes >= 1 && loaded.changes === cBefore);
check("loaded inventory restored (pickaxe present)", loaded.hasPickaxe);

// --- The expanded world's biome journey: forest, desert, snow, roofed ---
await page.click("#btn-menu");
await page.waitForTimeout(150);
await page.click("#btn-new-expanded");
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world.biome === "forest", { timeout: 8000 });
await page.waitForTimeout(400);
const biomes = await page.evaluate(() => {
  const S = window.Game.S, W = S.world, C = window.Game.CONST;
  const found = new Set();
  for (let x = 2; x < C.WORLD - 2; x += 3)
    for (let z = 2; z < C.WORLD - 2; z += 3) found.add(W.biomeAt(x, z));
  let sand = false, snow = false;
  for (const id of W.blocks.values()) {
    if (id === "sand") sand = true;
    else if (id === "snow") snow = true;
    if (sand && snow) break;
  }
  return { all: ["forest", "desert", "snow", "roofed"].every((b) => found.has(b)),
    sand, snow, animals: W.animals.length,
    stuck: S.player.collides(S.player.pos.x, S.player.pos.y, S.player.pos.z) };
});
check("the expanded world holds all four biomes", biomes.all);
check("the desert region has sand", biomes.sand);
check("the snowy mountains have snow", biomes.snow);
check("expanded world has animals", biomes.animals > 0);
check("expanded spawn not stuck", biomes.stuck === false);
await page.screenshot({ path: new URL("./screenshot-expanded.png", import.meta.url).pathname });

// --- Fall damage -> death -> respawn ---
await page.evaluate(() => {
  const S = window.Game.S;
  S.player.hp = 5;
  S.player.pos.y += 12;        // teleport high up
  S.player.vel.y = 0;
  S.player.fallPeak = S.player.pos.y;
});
let died = true;
try { await page.waitForFunction(() => window.Game.S.player.dead, { timeout: 6000 }); }
catch { died = false; }
const death = await page.evaluate(() => ({
  dead: window.Game.S.player.dead,
  panel: !document.getElementById("death-panel").classList.contains("hidden")
}));
check("a long fall can kill you", died && death.dead === true);
check("death screen appears", death.panel === true);
await page.click("#btn-respawn");
await page.waitForTimeout(250);
const resp = await page.evaluate(() => ({ dead: window.Game.S.player.dead, hp: window.Game.S.player.hp, food: window.Game.S.player.food }));
check("respawn revives the player", resp.dead === false && resp.hp === 20 && resp.food === 20);

// --- Tapping an apple grabs it even with a block in hand (no accidental place),
//     and the crosshair label names what you're pointing at ---
const appleAim = await aimAt(page, "apple");
check("apple sits in the crosshair", appleAim.hit
  && appleAim.hit.block.x === appleAim.block.x
  && appleAim.hit.block.y === appleAim.block.y
  && appleAim.hit.block.z === appleAim.block.z);
await page.waitForTimeout(50);
await worldTap(page);
await page.waitForTimeout(90);
const appleHit = await page.evaluate((cell) => {
  const S = window.Game.S, W = S.world;
  const count = (q) => S.inv.reduce((n, s) => n + (s && s.id === q ? s.count : 0), 0);
  return { gone: W.blocks.get(cell.x + "," + cell.y + "," + cell.z) !== "apple",
    apples: count("apple"), dirt: count("dirt") };
}, appleAim.block);
check("tapping an apple harvested it (did NOT place)", appleHit.gone);
check("the tap gave +1 apple", appleHit.apples === appleAim.apples + 1);
check("the held block was not used up", appleHit.dirt === appleAim.dirt);

// --- ...but tapping a plain block while holding one still builds ---
const buildAim = await aimAt(page, "stone");
await worldTap(page);
await page.waitForTimeout(90);
const built = await page.evaluate((place) => {
  const S = window.Game.S, W = S.world;
  const count = (q) => S.inv.reduce((n, s) => n + (s && s.id === q ? s.count : 0), 0);
  return { placed: W.blocks.get(place.x + "," + place.y + "," + place.z) === "dirt", dirt: count("dirt") };
}, buildAim.place);
check("tapping the ground/blocks still builds", built.placed);
check("building used up one held block", built.dirt === buildAim.dirt - 1);

// --- Diamond ore can be mined with a pickaxe ---
const diamondAim = await page.evaluate(() => {
  const S = window.Game.S, W = S.world, p = S.player;
  const key = (a, b, c) => a + "," + b + "," + c;
  p.pitch = 0; p.yaw = 0; p.vel.set(0, 0, 0); p.syncCamera();
  const eye = p.eyePosition(), dir = p.lookDir();
  for (let i = 0; i <= 5; i++) {
    W.blocks.delete(key(Math.floor(eye.x + dir.x * i), Math.floor(eye.y + dir.y * i), Math.floor(eye.z + dir.z * i)));
  }
  const bx = Math.floor(eye.x + dir.x * 3), by = Math.floor(eye.y + dir.y * 3), bz = Math.floor(eye.z + dir.z * 3);
  W.blocks.set(key(bx, by, bz), "diamond_ore");
  W.buildMeshes();
  S.inv[0] = { id: "pickaxe", count: 1 };
  document.querySelectorAll("#hotbar .slot")[0].click();
  const hit = W.raycast(eye, dir);
  const diamonds = S.inv.reduce((n, s) => n + (s && s.id === "diamond_ore" ? s.count : 0), 0);
  return { block: { x: bx, y: by, z: bz }, hit, diamonds };
});
check("diamond ore sits in the crosshair", diamondAim.hit
  && diamondAim.hit.block.x === diamondAim.block.x
  && diamondAim.hit.block.y === diamondAim.block.y
  && diamondAim.hit.block.z === diamondAim.block.z);
// Ore takes THREE swings of the wooden pickaxe, cracking along the way.
const swing = async () => {
  await page.evaluate(() => document.getElementById("btn-mine").click());
  await page.waitForTimeout(60);
  return page.evaluate((cell) => {
    const S = window.Game.S, W = S.world;
    const k = cell.x + "," + cell.y + "," + cell.z;
    return { there: W.blocks.get(k) === "diamond_ore", damage: W.mineDamage.get(k) || 0,
      diamonds: S.inv.reduce((n, s) => n + (s && s.id === "diamond_ore" ? s.count : 0), 0) };
  }, diamondAim.block);
};
const hit1 = await swing();
const hit2 = await swing();
const hit3 = await swing();
check("one pickaxe swing only cracks diamond ore", hit1.there && hit1.damage === 1);
check("a second swing cracks it further", hit2.there && hit2.damage === 2);
check("the third swing mines it", !hit3.there);
check("mining diamond ore drops a diamond", hit3.diamonds === diamondAim.diamonds + 1);

// --- Ladders: stand at the foot of a ladder, hold forward, and climb up ---
const climb = await page.evaluate(async () => {
  const S = window.Game.S, W = S.world, p = S.player;
  const key = (a, b, c) => a + "," + b + "," + c;
  const bx = 5, bz = 5;
  // Clear the ladder column and the player's own column beside it.
  for (let y = 1; y <= 12; y++) { W.blocks.delete(key(bx, y, bz)); W.blocks.delete(key(bx, y, bz + 1)); }
  W.blocks.set(key(bx, 0, bz + 1), "stone");          // floor to start on
  for (let y = 1; y <= 10; y++) W.blocks.set(key(bx, y, bz), "ladder"); // the ladder
  W.buildMeshes();
  p.pos.set(bx + 0.5, 1, bz + 1.5);
  p.yaw = 0; p.pitch = 0; p.vel.set(0, 0, 0); p.onGround = true; p.fallPeak = 1; p.hp = 20;
  p.syncCamera();
  const startY = p.pos.y;
  const front = p.ladderInFront();
  S.input.forward = true;
  // The big 96-block world renders slowly under headless software rasterizing,
  // so allow enough real time for a handful of game frames to run.
  await new Promise((r) => setTimeout(r, 1500));
  S.input.forward = false;
  return { front, startY, climbedY: p.pos.y, hp: p.hp };
});
check("a ladder is detected in front of you", climb.front === true);
check("holding forward climbs the ladder", climb.climbedY > climb.startY + 1);
check("climbing causes no fall damage", climb.hp === 20);

await browser.close();
server.close();

console.log("World info:", JSON.stringify(info));
console.log("");
let allOk = errors.length === 0;
for (const c of checks) { console.log((c.ok ? "  ✅ " : "  ❌ ") + c.name); if (!c.ok) allOk = false; }
console.log("\nErrors:", errors.length ? errors : "none");
console.log(allOk ? "\nSMOKE TEST PASSED ✅" : "\nSMOKE TEST FAILED ❌");
process.exit(allOk ? 0 : 1);
