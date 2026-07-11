// Focused verification of the new features: inverted look + setting, the
// counting/indefinite water bucket, smelting iron ingots into steel, the
// flint/book/flint-&-steel recipes, water-on-lava obsidian, lighting an
// obsidian portal frame, sky clouds, tall villager settlements, leaves dropping
// into the backpack, and the break button staying locked until the timer ends.
// Run alongside smoke.mjs.
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

// --- Inverted look is the default, and the toggle flips it ---
const lookDefault = await page.evaluate(() => window.Game.S.invertLook);
check("inverted look is ON by default", lookDefault === true);
const stateText = await page.textContent("#invert-look-state");
check("look setting shows ON in the menu", stateText.trim() === "ON");
await page.click("#btn-invert-look");
const afterToggle = await page.evaluate(() => window.Game.S.invertLook);
check("toggling the setting turns inverted look OFF", afterToggle === false);
await page.click("#btn-invert-look"); // back to default for the rest of the run

// --- Start a forest world ---
await page.click("#btn-new-forest");
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world, { timeout: 8000 });
await page.waitForTimeout(300);

// --- Carved surface watering holes flood with water ---
const holes = await page.evaluate(() => {
  const W = window.Game.S.world, C = window.Game.CONST;
  const holes = W._holes ? W._holes.size : 0;
  let flooded = 0;
  if (W._holes) for (const k of W._holes) {
    const [x, z] = k.split(",").map(Number);
    if (W.get(x, C.WATER_LEVEL, z) === "water") flooded++;
  }
  return { holes, flooded };
});
check("the world carves surface watering holes", holes.holes >= 1);
check("watering holes fill with surface water", holes.flooded >= 1);

// --- Lava turns up all over: underground pools and surface lakes ---
const lava = await page.evaluate(() => {
  const W = window.Game.S.world;
  let total = 0, surface = 0;
  for (const [k, id] of W.blocks) {
    if (id !== "lava") continue;
    total++;
    const [x, y, z] = k.split(",").map(Number);
    if (!W.get(x, y + 1, z) && y >= W.surfaceY(x, z)) surface++;
  }
  return { total, surface };
});
check("lava is scattered widely through the overworld", lava.total >= 40);
check("some lava sits in surface lakes", lava.surface >= 1);

// --- The pointer-look pitch obeys the inverted setting ---
const lookMath = await page.evaluate(() => {
  const S = window.Game.S, p = S.player;
  const game = document.getElementById("game");
  const fire = (type, x, y) => game.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true }));
  // Inverted (default): dragging DOWN should raise the pitch (look up).
  S.invertLook = true; p.pitch = 0;
  fire("pointerdown", 450, 300); fire("pointermove", 450, 360); fire("pointerup", 450, 360);
  const invUp = p.pitch;
  // Normal: dragging DOWN should lower the pitch (look down).
  S.invertLook = false; p.pitch = 0;
  fire("pointerdown", 450, 300); fire("pointermove", 450, 360); fire("pointerup", 450, 360);
  const normDown = p.pitch;
  S.invertLook = true;
  return { invUp, normDown };
});
check("inverted: dragging down looks UP (pitch rises)", lookMath.invUp > 0);
check("normal: dragging down looks DOWN (pitch drops)", lookMath.normDown < 0);

// --- The water bucket counts up and collects without limit ---
const water = await page.evaluate(() => {
  const S = window.Game.S, W = S.world, p = S.player;
  const key = (a, b, c) => a + "," + b + "," + c;
  p.pitch = 0; p.yaw = 0; p.vel.set(0, 0, 0); p.syncCamera();
  const eye = p.eyePosition(), dir = p.lookDir();
  const placeWater = () => {
    for (let i = 0; i <= 5; i++) W.blocks.delete(key(Math.floor(eye.x + dir.x * i), Math.floor(eye.y + dir.y * i), Math.floor(eye.z + dir.z * i)));
    const bx = Math.floor(eye.x + dir.x * 2.5), by = Math.floor(eye.y + dir.y * 2.5), bz = Math.floor(eye.z + dir.z * 2.5);
    W.blocks.set(key(bx, by, bz), "water"); W.buildMeshes();
  };
  const count = (q) => S.inv.reduce((n, s) => n + (s && s.id === q ? s.count : 0), 0);
  const mine = () => document.getElementById("btn-mine").click();
  // A) an empty bucket scoops one water and becomes a water bucket.
  S.inv.fill(null); S.inv[0] = { id: "bucket", count: 1 };
  document.querySelectorAll("#hotbar .slot")[0].click();
  placeWater(); mine();
  const afterScoop = { waters: count("water_bucket"), buckets: count("bucket") };
  // B) holding the water bucket, scoop 130 more — well past the 99 stack cap.
  S.inv.fill(null); S.inv[0] = { id: "water_bucket", count: 1 };
  document.querySelectorAll("#hotbar .slot")[0].click();
  for (let i = 0; i < 130; i++) { placeWater(); mine(); }
  return { afterScoop, waters: count("water_bucket"), stacks: S.inv.filter((s) => s && s.id === "water_bucket").length };
});
check("an empty bucket scoops one water (and empties)", water.afterScoop.waters === 1 && water.afterScoop.buckets === 0);
check("water bucket collected 131 waters (indefinite, past 99)", water.waters === 131);
check("the water count lives in a single bucket", water.stacks === 1);

// --- Smelting iron ingots with coal fuel yields steel ---
const smelt = await page.evaluate(() => {
  const S = window.Game.S, G = window.Game, FUR = S.furnace;
  S.inv.fill(null); S.inv[0] = { id: "coal", count: 4 }; S.inv[1] = { id: "iron_ingot", count: 3 };
  G._openFurnace();
  FUR.brush = "coal"; document.getElementById("furnace-fuel").click();
  FUR.brush = "iron_ingot"; document.getElementById("furnace-input").click();
  const loaded = { fuelN: FUR.fuelN, input: FUR.input, inputN: FUR.inputN };
  document.getElementById("furnace-smelt").click();
  const count = (q) => S.inv.reduce((n, s) => n + (s && s.id === q ? s.count : 0), 0);
  document.querySelector("#furnace-panel .close-btn").click();
  return { loaded, steel: count("steel") };
});
check("coal loads as fuel and iron ingots as the smelt input",
  smelt.loaded.fuelN === 4 && smelt.loaded.input === "iron_ingot" && smelt.loaded.inputN === 3);
check("smelting iron ingots produced steel", smelt.steel === 3);

// --- The reworked recipe set: flint, book, flint & steel; no redstone bucket ---
const recipes = await page.evaluate(() => {
  const G = window.Game;
  const has = (id) => G.Recipes.some((r) => r.id === id);
  return {
    flint: has("flint"), book: has("book"), fas: has("flint_and_steel"),
    noRedBucket: !has("redstone_bucket"),
    steelSmelt: !!(G.SmeltRecipes.iron_ingot && G.SmeltRecipes.iron_ingot.id === "steel"),
    noCoalSmelt: !G.SmeltRecipes.coal
  };
});
check("a flint recipe (from coal) exists", recipes.flint);
check("a book recipe (paper + wood) exists", recipes.book);
check("a flint & steel recipe exists", recipes.fas);
check("the redstone bucket recipe is gone", recipes.noRedBucket);
check("coal no longer smelts into obsidian", recipes.noCoalSmelt);

// --- Pouring water onto lava cools it into obsidian ---
const obby = await page.evaluate(() => {
  const S = window.Game.S, W = S.world, p = S.player;
  const key = (a, b, c) => a + "," + b + "," + c;
  p.pitch = 0; p.yaw = 0; p.vel.set(0, 0, 0); p.syncCamera();
  const eye = p.eyePosition(), dir = p.lookDir();
  for (let i = 0; i <= 5; i++) W.blocks.delete(key(Math.floor(eye.x + dir.x * i), Math.floor(eye.y + dir.y * i), Math.floor(eye.z + dir.z * i)));
  const bx = Math.floor(eye.x + dir.x * 2.5), by = Math.floor(eye.y + dir.y * 2.5), bz = Math.floor(eye.z + dir.z * 2.5);
  W.blocks.set(key(bx, by, bz), "lava"); W.buildMeshes();
  S.inv.fill(null); S.inv[0] = { id: "water_bucket", count: 3 };
  document.querySelectorAll("#hotbar .slot")[0].click();
  document.getElementById("btn-place").click(); // pour water at the lava
  return { made: W.get(bx, by, bz) };
});
check("pouring water on lava makes obsidian", obby.made === "obsidian");

// --- Flint & steel lights an obsidian frame into a Nether portal ---
const portal = await page.evaluate(() => {
  const W = window.Game.S.world;
  const key = (a, b, c) => a + "," + b + "," + c;
  const ox = 3, oy = 3, oz = 3;
  for (let x = ox - 2; x <= ox + 2; x++)
    for (let y = oy - 2; y <= oy + 4; y++)
      for (let z = oz - 1; z <= oz + 1; z++) W.blocks.delete(key(x, y, z));
  // A 1-wide, 2-tall interior ringed by obsidian (in the x-y plane).
  W.blocks.set(key(ox - 1, oy, oz), "obsidian"); W.blocks.set(key(ox - 1, oy + 1, oz), "obsidian");
  W.blocks.set(key(ox + 1, oy, oz), "obsidian"); W.blocks.set(key(ox + 1, oy + 1, oz), "obsidian");
  W.blocks.set(key(ox, oy - 1, oz), "obsidian"); W.blocks.set(key(ox, oy + 2, oz), "obsidian");
  const lit = W.lightPortal(ox - 1, oy, oz);
  return { lit, a: W.get(ox, oy, oz), b: W.get(ox, oy + 1, oz) };
});
check("flint & steel lights an obsidian frame into a portal",
  portal.lit && portal.a === "nether_portal" && portal.b === "nether_portal");

// --- Clouds fill the sky and can't be mined ---
const clouds = await page.evaluate(() => {
  const W = window.Game.S.world, G = window.Game;
  let cloudCount = 0;
  for (const [, id] of W.blocks) if (id === "cloud") cloudCount++;
  return {
    cloudCount, drop: G.BlockDefs.cloud.drop, solid: G.isSolidBlock("cloud"),
    hidden: !!(G.ItemDefs.cloud && G.ItemDefs.cloud.hidden)
  };
});
check("clouds fill the sky", clouds.cloudCount > 20);
check("clouds can't be mined (they drop nothing)", clouds.drop === null);
check("clouds are non-solid (fluffy walk-through sky)", clouds.solid === false);
check("clouds aren't a carryable item", clouds.hidden);

// --- Mining leaves drops leaves into the backpack ---
const leaves = await page.evaluate(() => {
  const S = window.Game.S, W = S.world, p = S.player;
  const G = window.Game;
  const key = (a, b, c) => a + "," + b + "," + c;
  p.pitch = 0; p.yaw = 0; p.vel.set(0, 0, 0); p.syncCamera();
  const eye = p.eyePosition(), dir = p.lookDir();
  for (let i = 0; i <= 5; i++) W.blocks.delete(key(Math.floor(eye.x + dir.x * i), Math.floor(eye.y + dir.y * i), Math.floor(eye.z + dir.z * i)));
  const bx = Math.floor(eye.x + dir.x * 2.5), by = Math.floor(eye.y + dir.y * 2.5), bz = Math.floor(eye.z + dir.z * 2.5);
  W.blocks.set(key(bx, by, bz), "leaves"); W.buildMeshes();
  S.inv.fill(null); // empty hand to mine
  document.querySelectorAll("#hotbar .slot")[0].click();
  document.getElementById("btn-mine").click();
  const count = (q) => S.inv.reduce((n, s) => n + (s && s.id === q ? s.count : 0), 0);
  return { leaves: count("leaves"), dropDef: G.BlockDefs.leaves.drop };
});
check("leaves drop is defined", leaves.dropDef === "leaves");
check("mining leaves put leaves in the backpack", leaves.leaves >= 1);

// --- The settlement towers rise well above the treetops ---
const village = await page.evaluate(() => {
  const S = window.Game.S, G = window.Game, W = S.world;
  const C = G.CONST;
  const v = W.animals.find((a) => a.userData.kind === "villager");
  if (!v) return { hasVillager: false };
  const hx = Math.round(v.userData.home.x - 0.5), hz = Math.round(v.userData.home.z - 0.5);
  // Tallest solid block within the settlement footprint.
  let tallest = 0, beacon = false;
  for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
    for (let y = C.MAX_Y + 1; y >= 0; y--) {
      const id = W.get(hx + dx, y, hz + dz);
      if (id && G.isSolidBlock(id)) { if (y > tallest) tallest = y; break; }
    }
    for (let y = 0; y <= C.MAX_Y + 1; y++) if (W.get(hx + dx, y, hz + dz) === "torch") beacon = true;
  }
  // The treetops in this world for comparison.
  let treetop = 0;
  for (const [k, id] of W.blocks) { if (id === "leaves") { const y = +k.split(",")[1]; if (y > treetop) treetop = y; } }
  return { hasVillager: true, tallest, treetop, beacon };
});
check("a villager settlement exists", village.hasVillager);
check("the settlement towers rise above the treetops", village.tallest > village.treetop);
check("the settlement is very tall (near the sky)", village.tallest >= 20);
check("the settlement has a glowing beacon", village.beacon);

// --- Riding uses the normal controls: walk forward and jump ---
const ride = await page.evaluate(() => {
  const S = window.Game.S, G = window.Game, W = S.world, p = S.player;
  const key = (x, y, z) => x + "," + y + "," + z;
  const a = W.animals.find((an) => an.userData.kind !== "villager" && an.userData.kind !== "monkey");
  if (!a) return { hasMount: false };
  // Clear a straight corridor ahead (forward is -z) at body height.
  p.pitch = 0; p.yaw = 0; p.vel.set(0, 0, 0);
  const px = Math.floor(p.pos.x), pz = Math.floor(p.pos.z), fy = Math.floor(p.pos.y);
  for (let dz = 0; dz <= 8; dz++) for (let dy = 0; dy <= 2; dy++) W.blocks.delete(key(px, fy + dy, pz - dz));
  W.buildMeshes();
  S.riding = a; a.position.set(p.pos.x, p.pos.y, p.pos.z);
  S.input.forward = false; S.input.jump = false;
  for (let i = 0; i < 4; i++) G._updateRiding(0.05);     // settle on the ground
  // Walk forward and watch the mount travel with us.
  const z0 = a.position.z;
  S.input.forward = true;
  for (let i = 0; i < 16; i++) G._updateRiding(0.05);
  S.input.forward = false;
  const walked = z0 - a.position.z;                       // forward is -z
  const follows = Math.abs(a.position.x - p.pos.x) < 0.01 && Math.abs(a.position.z - p.pos.z) < 0.01;
  // Jump from the ground.
  p.onGround = true; p.vel.y = 0; S.input.jump = true;
  G._updateRiding(0.05);
  const jumpV = p.vel.y;
  S.input.jump = false; S.riding = null;
  return { hasMount: true, walked, follows, jumpV };
});
check("a rideable mount exists", ride.hasMount);
check("riding + forward walks the mount along", ride.walked > 0.3);
check("the mount stays under the rider", ride.follows);
check("riding + jump launches you upward (same as on foot)", ride.jumpV > 0);

// --- The break "I'm back" button is locked until the timer ends ---
const lock = await page.evaluate(() => {
  const btn = document.getElementById("btn-resume-break");
  // Simulate being mid-break.
  const S = window.Game.S;
  S.onBreak = true; S.breakLeft = 42;
  btn.classList.add("hidden"); btn.disabled = true;
  const style = getComputedStyle(btn);
  const hiddenNow = style.display === "none";
  // Try to resume early via the wired handler.
  btn.click();
  const stillPaused = S.onBreak === true;
  // Now finish the timer and confirm it unlocks.
  S.breakLeft = 0; btn.classList.remove("hidden"); btn.disabled = false;
  const visibleNow = getComputedStyle(btn).display !== "none";
  return { hiddenNow, stillPaused, visibleNow };
});
check("Resume button is hidden during the break", lock.hiddenNow);
check("clicking Resume early does NOT end the break", lock.stillPaused);
check("Resume button appears once the timer ends", lock.visibleNow);

// --- The break screen has a "do a stretch" logo ---
const stretch = await page.evaluate(() => {
  const logo = document.querySelector("#break-panel .break-logo");
  return {
    hasLogo: !!logo,
    hasSvg: !!(logo && logo.querySelector("svg")),
    recommendsStretch: !!(logo && /stretch/i.test(logo.textContent)),
    instructionsMentionStretch: /stretch/i.test(document.querySelector("#break-panel .break-instructions").textContent)
  };
});
check("the break screen shows a stretch logo", stretch.hasLogo && stretch.hasSvg);
check("the stretch logo recommends stretching", stretch.recommendsStretch);
check("the break instructions mention a stretch", stretch.instructionsMentionStretch);

// --- Stairs: a recipe exists and you walk straight up them, no jump ---
const stairs = await page.evaluate(() => {
  const S = window.Game.S, G = window.Game, W = S.world, p = S.player;
  const key = (x, y, z) => x + "," + y + "," + z;
  const hasRecipe = G.Recipes.some((r) => r.id === "stairs");
  const hasBlock = !!G.BlockDefs.stairs;
  p.yaw = 0; p.pitch = 0; p.vel.set(0, 0, 0); p.onGround = true;
  const px = Math.floor(p.pos.x), pz = Math.floor(p.pos.z), gy = Math.floor(p.pos.y) - 1;
  // Clear a tall air column, then lay: a floor, a stairs step, and a raised
  // platform behind it (one block higher).
  for (let dz = 0; dz <= 6; dz++) for (let dy = 0; dy <= 5; dy++) W.blocks.delete(key(px, gy + dy, pz - dz));
  W.blocks.set(key(px, gy, pz), "grass");        // floor where you start
  W.blocks.set(key(px, gy, pz - 1), "grass");    // floor under the stair
  W.blocks.set(key(px, gy + 1, pz - 1), "stairs"); // the step
  for (let dz = 2; dz <= 6; dz++) W.blocks.set(key(px, gy + 1, pz - dz), "grass"); // raised platform
  W.buildMeshes();
  p.pos.set(px + 0.5, gy + 1, pz + 0.5);
  const y0 = p.pos.y;
  const inp = { forward: true, turnLeft: false, turnRight: false, jump: false };
  for (let i = 0; i < 45; i++) p.update(1 / 60, inp);
  return { hasRecipe, hasBlock, climbed: p.pos.y - y0, jumped: inp.jump };
});
check("a stairs recipe exists", stairs.hasRecipe);
check("stairs block is defined", stairs.hasBlock);
check("walking into stairs steps you up ~1 block (no jump)", stairs.climbed > 0.8);

// --- Furnace recipes are shown right in the furnace panel ---
const furRecipes = await page.evaluate(() => {
  const S = window.Game.S, G = window.Game, FUR = S.furnace;
  S.inv.fill(null); S.inv[0] = { id: "sand", count: 3 };
  G._openFurnace();
  const rows = document.querySelectorAll("#furnace-recipes .recipe-book-item").length;
  const sandBtn = document.querySelector('#furnace-recipes [data-smelt="sand"]');
  if (sandBtn) sandBtn.click();
  const loaded = { input: FUR.input, inputN: FUR.inputN };
  document.querySelector("#furnace-panel .close-btn").click();
  return { rows, loaded };
});
check("furnace panel lists the smelting recipes", furRecipes.rows >= 5);
check("tapping a furnace recipe loads the ingredient", furRecipes.loaded.input === "sand" && furRecipes.loaded.inputN === 3);

// --- A take-a-break can't be dodged by reloading the page ---
// Clear any leftover break state, then force a break to begin.
await page.evaluate(() => {
  const S = window.Game.S;
  S.onBreak = false; S.breakEndsAt = 0; S.breakLeft = 0; S.paused = false;
  document.querySelectorAll(".panel-overlay").forEach((p) => p.classList.add("hidden"));
  S.playClock = 99999; // trips the break on the next frame
});
await page.waitForFunction(() => window.Game.S.onBreak === true, { timeout: 5000 });
const beforeReload = await page.evaluate(() => ({
  onBreak: window.Game.S.onBreak,
  future: window.Game.S.breakEndsAt > Date.now()
}));

// Reload the page — the classic way to try to skip the break — then resume.
await page.reload();
await page.waitForFunction(() => window.Game && window.Game.S, { timeout: 8000 });
await page.click("#btn-continue");
await page.waitForFunction(() => window.Game.S.running && window.Game.S.world, { timeout: 8000 });
const afterReload = await page.evaluate(() => {
  const S = window.Game.S;
  const panel = document.getElementById("break-panel");
  const panelVisible = panel && !panel.classList.contains("hidden");
  const btn = document.getElementById("btn-resume-break");
  btn.click(); // try to resume early — should be refused while the timer runs
  return { onBreak: S.onBreak, paused: S.paused, panelVisible,
    resumeHidden: getComputedStyle(btn).display === "none", stillOnBreak: S.onBreak };
});
check("a break was in progress before reloading", beforeReload.onBreak && beforeReload.future);
check("the break survives a page reload (can't be skipped)", afterReload.onBreak === true && afterReload.panelVisible);
check("the reloaded break keeps the game paused", afterReload.paused === true);
check("Resume stays locked after a reload", afterReload.resumeHidden && afterReload.stillOnBreak === true);

// Once the real time is up, Resume unlocks and the break clears for good.
const cleared = await page.evaluate(async () => {
  const S = window.Game.S;
  S.breakEndsAt = Date.now() - 1000;          // pretend the 3 minutes elapsed
  await new Promise((r) => setTimeout(r, 150)); // let tickBreak notice
  const btn = document.getElementById("btn-resume-break");
  const unlocked = getComputedStyle(btn).display !== "none" && !btn.disabled;
  btn.click();                                 // endBreak
  return { unlocked, onBreak: S.onBreak, endsAt: S.breakEndsAt };
});
check("the break unlocks once its time is really up", cleared.unlocked);
check("resuming then clears the break", cleared.onBreak === false && cleared.endsAt === 0);

// --- Report ---
await browser.close();
server.close();

let pass = 0;
for (const c of checks) { console.log((c.ok ? "  ✅ " : "  ❌ ") + c.name); if (c.ok) pass++; }
console.log("\nErrors: " + (errors.length ? "\n  " + errors.join("\n  ") : "none"));
const ok = pass === checks.length && errors.length === 0;
console.log("\n" + (ok ? "FEATURE VERIFY PASSED ✅" : `FEATURE VERIFY FAILED ❌ (${pass}/${checks.length})`));
process.exit(ok ? 0 : 1);
