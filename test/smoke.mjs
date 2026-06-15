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
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

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

// --- Start a forest world ---
await page.click("#btn-new-forest");
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world, { timeout: 8000 });
await page.waitForTimeout(400);

const info = await page.evaluate(() => {
  const S = window.Game.S;
  return {
    running: S.running, biome: S.world.biome, blockCount: S.world.blocks.size,
    meshTypes: Object.keys(S.world.meshes).length, animals: S.world.animals.length,
    hp: S.player.hp, food: S.player.food,
    spawnStuck: S.player.collides(S.player.pos.x, S.player.pos.y, S.player.pos.z)
  };
});
check("world running", info.running);
check("world has many blocks", info.blockCount > 1000);
check("multiple block types rendered", info.meshTypes >= 3);
check("animals spawned", info.animals > 0);
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

// --- Crafting: give wood, open craft panel, craft a stick + table ---
await page.evaluate(() => { window.Game.S.inv[0] = { id: "wood", count: 8 }; });
await page.click("#btn-craft");
await page.waitForTimeout(150);
// click the first two craftable rows (stick, then crafting_table)
await page.click("#recipe-list .recipe:nth-child(1) .craft-go");
await page.click("#recipe-list .recipe:nth-child(2) .craft-go");
const craft = await page.evaluate(() => {
  const inv = window.Game.S.inv.filter(Boolean);
  const has = (id) => inv.some((s) => s.id === id);
  const count = (id) => inv.filter((s) => s.id === id).reduce((a, s) => a + s.count, 0);
  const pickaxeBtn = document.querySelectorAll("#recipe-list .craft-go")[3];
  return { stick: has("stick"), table: has("crafting_table"), wood: count("wood"),
    pickaxeDisabledNoTable: pickaxeBtn ? pickaxeBtn.disabled : null };
});
check("crafted a stick", craft.stick);
check("crafted a crafting table", craft.table);
check("wood was consumed (8 - 2 - 4 = 2)", craft.wood === 2);
check("pickaxe needs a table (disabled)", craft.pickaxeDisabledNoTable === true);
await page.click("#craft-panel .close-btn");

// --- Placing a block: select dirt, aim down, press Place ---
const placeResult = await page.evaluate(async () => {
  const S = window.Game.S;
  S.inv[1] = { id: "dirt", count: 10 };
  // select slot 1 by clicking its hotbar element
  document.querySelectorAll("#hotbar .slot")[1].click();
  S.player.pitch = -0.5; // look down at the ground a few blocks ahead
  const changesBefore = S.world.changes.size;
  document.getElementById("btn-place").click();
  await new Promise((r) => setTimeout(r, 60));
  return { changed: S.world.changes.size > changesBefore, dirtLeft: S.inv[1] ? S.inv[1].count : 0 };
});
check("placed a block (world changed)", placeResult.changed);
check("a dirt block was consumed", placeResult.dirtLeft === 9);

// --- Mining without a pickaxe on placed dirt (hand-breakable) ---
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

// --- Saving ---
const save = await page.evaluate(async () => {
  const S = window.Game.S;
  document.getElementById("btn-save").click();
  await new Promise((r) => setTimeout(r, 50));
  return { saved: !!localStorage.getItem("blocky-world-save-v1") };
});
check("game saved to localStorage", save.saved);
await page.screenshot({ path: new URL("./screenshot.png", import.meta.url).pathname });

// --- Pickaxe crafting (needs a table) ---
await page.evaluate(() => {
  const S = window.Game.S;
  S.craftTable = true;
  S.inv[3] = { id: "stick", count: 2 };
  S.inv[4] = { id: "wood", count: 3 };
});
await page.click("#btn-craft");
await page.waitForTimeout(120);
await page.click("#recipe-list .recipe:nth-child(4) .craft-go"); // 4th recipe = pickaxe
const pick = await page.evaluate(() => window.Game.S.inv.some((s) => s && s.id === "pickaxe"));
check("crafted a pickaxe (with table)", pick);
await page.click("#craft-panel .close-btn");

// --- Save + load round-trip (forest world is restored) ---
const cBefore = await page.evaluate(() => window.Game.S.world.changes.size);
await page.click("#btn-menu");            // saves the forest world + opens the title
await page.waitForTimeout(150);
await page.click("#btn-continue");        // loads it back
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world.biome === "forest", { timeout: 8000 });
await page.waitForTimeout(200);
const loaded = await page.evaluate(() => {
  const S = window.Game.S;
  return { biome: S.world.biome, changes: S.world.changes.size, hasPickaxe: S.inv.some((s) => s && s.id === "pickaxe") };
});
check("loaded world is a forest", loaded.biome === "forest");
check("loaded world kept its edits", loaded.changes >= 1 && loaded.changes === cBefore);
check("loaded inventory restored (pickaxe present)", loaded.hasPickaxe);

// --- Desert biome ---
await page.click("#btn-menu");
await page.waitForTimeout(150);
await page.click("#btn-new-desert");
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world.biome === "desert", { timeout: 8000 });
await page.waitForTimeout(400);
const desert = await page.evaluate(() => {
  const S = window.Game.S;
  let sand = false;
  for (const id of S.world.blocks.values()) { if (id === "sand") { sand = true; break; } }
  return { biome: S.world.biome, sand: sand, animals: S.world.animals.length,
    stuck: S.player.collides(S.player.pos.x, S.player.pos.y, S.player.pos.z) };
});
check("desert world generated", desert.biome === "desert");
check("desert has sand", desert.sand);
check("desert has animals", desert.animals > 0);
check("desert spawn not stuck", desert.stuck === false);
await page.screenshot({ path: new URL("./screenshot-desert.png", import.meta.url).pathname });

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

await browser.close();
server.close();

console.log("World info:", JSON.stringify(info));
console.log("");
let allOk = errors.length === 0;
for (const c of checks) { console.log((c.ok ? "  ✅ " : "  ❌ ") + c.name); if (!c.ok) allOk = false; }
console.log("\nErrors:", errors.length ? errors : "none");
console.log(allOk ? "\nSMOKE TEST PASSED ✅" : "\nSMOKE TEST FAILED ❌");
process.exit(allOk ? 0 : 1);
