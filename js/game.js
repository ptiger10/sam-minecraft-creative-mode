/* ===========================================================
   game.js — the glue: Three.js scene, inventory, crafting,
   on-screen + keyboard controls, the main loop and saving to
   localStorage.
   =========================================================== */

(function (Game) {
  "use strict";

  const C = Game.CONST;
  // Three save slots. The pre-slots save key is migrated into slot 1 on boot.
  const OLD_SAVE_KEY = "blocky-world-save-v1";
  const SLOT_KEYS = ["blocky-world-save-slot1", "blocky-world-save-slot2", "blocky-world-save-slot3"];
  const SETTINGS_KEY = "blocky-world-settings-v1";

  // Whole-game state.
  const S = {
    renderer: null,
    camera: null,
    scene: null,
    world: null,
    player: null,
    inv: new Array(36).fill(null),
    equip: { helmet: null, chestplate: null, leggings: null, boots: null, shield: null },
    selected: 0,
    input: { forward: false, turnLeft: false, turnRight: false, jump: false },
    highlight: null,
    viewmodel: null,
    offhand: null,           // left-hand viewmodel (holds an equipped shield)
    raycaster: new THREE.Raycaster(),
    running: false,
    paused: false,
    craftTable: false,
    swing: 0,
    last: 0,
    autosaveTimer: 0,
    riding: null,            // the animal you're currently riding (or null)
    chests: {},              // "x,y,z" -> array of stored item stacks
    openChestKey: null,      // which chest the chest panel is showing
    saveSlot: null,          // 1..3 once the player picks a slot; null = no autosave yet
    tradingWith: null,       // the villager whose trade panel is open
    questKeysGiven: {},      // keyN -> true once a villager has handed it over (one-time)
    overworld: null,         // the surface world (kept while you visit the Nether)
    netherWorld: null,       // the Nether dimension (built on first entry)
    inNether: false,         // true while the player is in the Nether
    endWorld: null,          // the End dimension (built on first entry)
    inEnd: false,            // true while the player is in The End
    won: false,              // true once the exit portal has been stepped through
    creditsEnding: false,    // the credits are the winning finale (not the plaque)
    portalCooldown: 0,       // brief delay after a portal so it doesn't bounce you
    portalLinks: [],         // player-lit overworld portals <-> their Nether twins
    questPortalExit: null,   // the overworld cell you return to from the Nether
    playClock: 0,            // seconds of *active* play since the last break
    onBreak: false,          // true while the take-a-break overlay is showing
    breakLeft: 0,            // seconds remaining on the break countdown
    breakEndsAt: 0,          // wall-clock (ms) the break ends — survives reloads
    worldClock: 0,           // seconds into the day/night cycle
    invertLook: true         // pull DOWN to look UP (inverted) — the default
  };
  // Day/night: 3½ minutes of daylight, then 1½ minutes of night — so night
  // (and its monsters) comes round every 5 minutes.
  const DAY_LEN = 3.5 * 60, NIGHT_LEN = 1.5 * 60, CYCLE_LEN = DAY_LEN + NIGHT_LEN;
  const DUSK = 10; // seconds of dusk/dawn fade at each edge of night
  Game.S = S;
  const CHEST_SIZE = 27;
  // Full-size worlds are this wide; loading an old 40-block save shrinks
  // Game.CONST.WORLD for that session (see loadGame), so remember the default.
  const DEFAULT_WORLD_SIZE = Game.CONST.WORLD;

  // Take a healthy break: after 17 minutes of actual play, save + pause the
  // game and run a 3-minute countdown before letting the player resume.
  const BREAK_EVERY = 17 * 60;   // seconds of active play between breaks
  const BREAK_LENGTH = 3 * 60;   // how long the break lasts

  // ---- Small helpers --------------------------------------------
  const $ = (id) => document.getElementById(id);
  const hex = (n) => "#" + (n >>> 0).toString(16).padStart(6, "0");

  // A distinctive little icon for each item: emoji items render their emoji;
  // block/material items render a tiny shaded "cube" (a lit top over a darker
  // side) so each material reads differently, and ores get a speckled overlay.
  // Little shaped silhouettes (helmet, chestplate, leggings, boots, shield) so
  // armour reads at a glance instead of looking like a plain coloured square.
  // Each is tinted with its material colour. viewBox is 0..24.
  const ARMOR_SHAPES = {
    helmet: '<path d="M5 12a7 7 0 0 1 14 0v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" fill="L" stroke="D" stroke-width="1.4"/><rect x="7.3" y="12.4" width="9.4" height="2.7" rx="0.6" fill="D"/>',
    chestplate: '<path d="M5 8c2-2 4.5-2.5 7-2.5S17 6 19 8v3l-2 1v6.5a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V12L5 11z" fill="L" stroke="D" stroke-width="1.3" stroke-linejoin="round"/><line x1="12" y1="7" x2="12" y2="19" stroke="D" stroke-width="1"/>',
    leggings: '<path d="M7 5h10l-.6 6-1 8h-2.6l-.8-6-.8 6H8.6l-1-8z" fill="L" stroke="D" stroke-width="1.3" stroke-linejoin="round"/>',
    boots: '<path d="M5 4h4v7h3.5v4H5z" fill="L" stroke="D" stroke-width="1.1" stroke-linejoin="round"/><path d="M19 4h-4v7h-3.5v4H19z" fill="L" stroke="D" stroke-width="1.1" stroke-linejoin="round"/>',
    shield: '<path d="M12 3l7 2.2V11c0 5-3 8.2-7 10-4-1.8-7-5-7-10V5.2z" fill="L" stroke="D" stroke-width="1.4" stroke-linejoin="round"/><line x1="12" y1="4" x2="12" y2="22" stroke="D" stroke-width="0.9"/>'
  };
  function armorSvgURI(slot, light, dark) {
    const body = (ARMOR_SHAPES[slot] || ARMOR_SHAPES.chestplate)
      .replace(/L/g, light).replace(/D/g, dark);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + body + "</svg>";
    return "url('data:image/svg+xml," + encodeURIComponent(svg) + "')";
  }
  function armorIconHTML(def, ghost) {
    const light = ghost ? "#808690" : hex(def.swatch);
    const dark = ghost ? "#5a606a" : hex(def.swatchSide !== undefined ? def.swatchSide : Game.mix(def.swatch, 0x000000, 0.4));
    const cls = "swatch armor-swatch" + (ghost ? " armor-ghost" : "");
    return '<span class="' + cls + '" style="background-image:' + armorSvgURI(def.slot, light, dark) + '"></span>';
  }

  function iconHTML(id) {
    const def = Game.itemDef(id);
    if (!def) return "";
    if (def.equip && def.slot) return armorIconHTML(def, false);
    if (def.emoji) return '<span class="emoji">' + def.emoji + "</span>";
    if (def.swatch !== undefined) {
      const top = hex(def.swatch);
      const side = hex(def.swatchSide !== undefined ? def.swatchSide : Game.mix(def.swatch, 0x000000, 0.34));
      let bg = "linear-gradient(150deg," + top + " 0 54%," + side + " 54% 100%)";
      if ((def.ore || def.speckled) && def.speckle !== undefined) {
        // Little SQUARE specks (not round dots), to match the game's blocky look.
        // A one-quadrant conic gradient fills a small square in each 9px tile, so
        // the specks read as a sparse grid of little blocks over the base colour.
        const sp = hex(def.speckle);
        const sq = "conic-gradient(" + sp + " 0 25%, transparent 0)";
        bg = sq + " 0 0/9px 9px," + bg;
      }
      return '<span class="swatch" style="background:' + bg + '"></span>';
    }
    return '<span class="emoji">?</span>';
  }
  Game._iconHTML = iconHTML; // (used by the tests)

  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1400);
  }
  Game.toast = toast;

  // ===============================================================
  //  Inventory
  // ===============================================================
  // Stack `count` of `id` into any array of slots (the inventory or a chest).
  // Returns how many actually fit.
  function stackInto(arr, id, count) {
    let remaining = count;
    for (let i = 0; i < arr.length && remaining > 0; i++) {
      const s = arr[i];
      if (s && s.id === id && s.count < Game.MAX_STACK) {
        const add = Math.min(Game.MAX_STACK - s.count, remaining);
        s.count += add; remaining -= add;
      }
    }
    for (let i = 0; i < arr.length && remaining > 0; i++) {
      if (!arr[i]) {
        const add = Math.min(Game.MAX_STACK, remaining);
        arr[i] = { id: id, count: add }; remaining -= add;
      }
    }
    return count - remaining;
  }

  function addItem(id, count) {
    const fit = stackInto(S.inv, id, count);
    renderHotbar();
    if (!$("inventory-panel").classList.contains("hidden")) renderInventory();
    return fit;
  }

  // A water bucket holds an unlimited number of waters, so it ignores the
  // normal stack limit: pour the waters into an existing water bucket if there
  // is one, otherwise start a fresh one.
  function collectWater(n) {
    for (const s of S.inv) {
      if (s && s.id === "water_bucket") {
        s.count += n;
        renderHotbar();
        if (!$("inventory-panel").classList.contains("hidden")) renderInventory();
        return;
      }
    }
    addItem("water_bucket", n);
  }

  function countItem(id) {
    let n = 0;
    for (const s of S.inv) if (s && s.id === id) n += s.count;
    return n;
  }

  function removeItems(need) {
    // verify first
    for (const id in need) if (countItem(id) < need[id]) return false;
    for (const id in need) {
      let left = need[id];
      for (let i = 0; i < S.inv.length && left > 0; i++) {
        const s = S.inv[i];
        if (s && s.id === id) {
          const take = Math.min(s.count, left);
          s.count -= take; left -= take;
          if (s.count <= 0) S.inv[i] = null;
        }
      }
    }
    return true;
  }

  // Show a number on a slot whenever there's more than one — and always for a
  // water bucket, so you can read off how many waters it holds at a glance.
  function showSlotCount(s) { return !!(s && (s.count > 1 || s.id === "water_bucket")); }

  function selectedSlot() { return S.inv[S.selected]; }

  function selectSlot(i) {
    S.selected = i;
    renderHotbar();
    if (!$("inventory-panel").classList.contains("hidden")) renderInventory();
    updateHand();
    updateInvTitle(S.inv[i] ? S.inv[i].id : null);
    setViewmodel(selectedSlot() ? selectedSlot().id : null);
  }

  // The little title bar in the inventory panel that names (and describes)
  // whatever you last clicked on.
  function updateInvTitle(id) {
    const t = $("inv-title");
    if (!t) return;
    if (!id) {
      t.innerHTML = '<span class="inv-title-name">Tap an item to see what it is</span>';
      return;
    }
    const def = Game.itemDef(id);
    t.innerHTML = '<span class="inv-title-icon">' + iconHTML(id) + "</span>" +
      '<span class="inv-title-text"><b>' + Game.itemName(id) + "</b>" +
      (def && def.desc ? '<br><small>' + def.desc + "</small>" : "") + "</span>";
  }

  function buildSlotEl(i) {
    const el = document.createElement("div");
    el.className = "slot" + (i === S.selected ? " selected" : "");
    const s = S.inv[i];
    if (s) {
      el.innerHTML = iconHTML(s.id) + (showSlotCount(s) ? '<span class="count">' + s.count + "</span>" : "");
      const def = Game.itemDef(s.id);
      el.title = Game.itemName(s.id) + (def && def.equip ? " — tap to wear" : "");
    }
    // Armour and shields are worn on tap; everything else goes to your hand.
    const isEquip = s && Game.itemDef(s.id) && Game.itemDef(s.id).equip;
    el.addEventListener("click", () => (isEquip ? equipItem(i) : selectSlot(i)));
    return el;
  }

  function renderHotbar() {
    const bar = $("hotbar");
    bar.innerHTML = "";
    for (let i = 0; i < 9; i++) bar.appendChild(buildSlotEl(i));
  }

  function renderInventory() {
    renderEquip();
    const grid = $("inv-grid");
    grid.innerHTML = "";
    for (let i = 0; i < S.inv.length; i++) grid.appendChild(buildSlotEl(i));
    updateInvTitle(S.inv[S.selected] ? S.inv[S.selected].id : null);
  }

  function emptyEquip() {
    return { helmet: null, chestplate: null, leggings: null, boots: null, shield: null };
  }

  // Draw the five equipment slots. A filled slot shows its piece (tap to take
  // off); an empty slot shows a faint silhouette of what goes there.
  function renderEquip() {
    const row = $("equip-row");
    if (!row) return;
    row.innerHTML = "";
    Game.EQUIP_SLOTS.forEach((slot) => {
      const el = document.createElement("div");
      el.className = "slot equip-slot equip-" + slot;
      const id = S.equip[slot];
      if (id) {
        el.classList.add("filled");
        el.innerHTML = iconHTML(id);
        el.title = Game.itemName(id) + " — tap to take off";
        el.addEventListener("click", () => unequipSlot(slot));
      } else {
        // A ghost silhouette hints what the slot is for.
        el.innerHTML = armorIconHTML({ slot: slot, swatch: 0x808690 }, true);
        el.title = slot.charAt(0).toUpperCase() + slot.slice(1) + " slot";
        el.addEventListener("click", () => toast("Craft or find " + slot + " armour, then tap it in your backpack to wear it."));
      }
      row.appendChild(el);
    });
  }

  // Wear a piece from the backpack: it moves into its slot (swapping out any
  // piece already there). Anything that isn't armour just gets selected instead.
  function equipItem(i) {
    const s = S.inv[i];
    if (!s) return;
    const def = Game.itemDef(s.id);
    if (!def || !def.equip || !def.slot) { selectSlot(i); return; }
    const slot = def.slot;
    const prev = S.equip[slot];
    const wearing = s.id;
    s.count -= 1;
    if (s.count <= 0) S.inv[i] = null;
    S.equip[slot] = wearing;
    if (prev) addItem(prev, 1);          // the piece you were wearing goes back
    toast("🛡️ Now wearing the " + Game.itemName(wearing) + "!");
    renderHotbar(); renderInventory(); updateHand();
    setViewmodel(selectedSlot() ? selectedSlot().id : null);
    updateOffhand();                     // a newly-worn shield shows in your hand
  }
  Game._equipItem = equipItem;           // (used by the tests)

  // Take a piece off — it returns to the backpack if there's room.
  function unequipSlot(slot) {
    const id = S.equip[slot];
    if (!id) return;
    if (addItem(id, 1) < 1) { toast("Your backpack is full — make room first."); return; }
    S.equip[slot] = null;
    toast("Took off the " + Game.itemName(id) + ".");
    renderHotbar(); renderInventory();
    updateOffhand();                     // taking off a shield clears your hand
  }
  Game._unequipSlot = unequipSlot;       // (used by the tests)

  function updateHand() {
    const s = selectedSlot();
    const display = $("hand-display");
    if (s) {
      display.classList.remove("hidden");
      $("hand-icon").innerHTML = iconHTML(s.id);
      $("hand-name").textContent = Game.itemName(s.id) + (showSlotCount(s) ? " x" + s.count : "");
    } else {
      // Empty hand: hide the indicator entirely rather than showing a chip.
      display.classList.add("hidden");
      $("hand-icon").innerHTML = "";
      $("hand-name").textContent = "";
    }
  }

  // ===============================================================
  //  Crafting — a real shaped grid (2x2 from the Craft button, 3x3 at a table)
  // ===============================================================
  // The grid is filled by tapping an ingredient (the "brush") and then tapping
  // squares; ingredients are pulled from your inventory as you place them and
  // returned if you take them back out or close the panel. The result square
  // shows what the current arrangement makes; tap it to craft.
  const CR = { size: 2, grid: [], brush: null, tab: "craft" };
  S.craft = CR;

  // ---- Shaped-recipe matching -----------------------------------
  function trimPattern(rows) {
    const rowHas = (r) => rows[r].some((c) => c);
    let top = 0, bottom = rows.length - 1;
    while (top <= bottom && !rowHas(top)) top++;
    while (bottom >= top && !rowHas(bottom)) bottom--;
    if (top > bottom) return [];
    let left = Infinity, right = -Infinity;
    for (let r = top; r <= bottom; r++)
      for (let c = 0; c < rows[r].length; c++)
        if (rows[r][c]) { left = Math.min(left, c); right = Math.max(right, c); }
    const out = [];
    for (let r = top; r <= bottom; r++) {
      const row = [];
      for (let c = left; c <= right; c++) row.push(rows[r][c] || null);
      out.push(row);
    }
    return out;
  }

  function patternsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let r = 0; r < a.length; r++) {
      if (a[r].length !== b[r].length) return false;
      for (let c = 0; c < a[r].length; c++)
        if ((a[r][c] || null) !== (b[r][c] || null)) return false;
    }
    return true;
  }

  function gridRows() {
    const rows = [];
    for (let r = 0; r < CR.size; r++) {
      const row = [];
      for (let c = 0; c < CR.size; c++) row.push(CR.grid[r * CR.size + c] || null);
      rows.push(row);
    }
    return rows;
  }

  // The recipe the current grid makes (or null). Recipes that need a table are
  // only matched when one is in use.
  function currentRecipe() {
    const gp = trimPattern(gridRows());
    if (!gp.length) return null;
    for (const r of Game.Recipes) {
      if (r.table && !CR.table) continue;
      if (!r._trim) r._trim = trimPattern(r.pattern);
      if (patternsEqual(gp, r._trim)) return r;
    }
    return null;
  }
  Game._currentRecipe = currentRecipe; // (used by the smoke test)

  function openCrafting(table) {
    returnGrid();                 // tidy up anything left from a previous open
    CR.table = !!table;
    S.craftTable = !!table;
    CR.size = table ? 3 : 2;
    CR.grid = new Array(CR.size * CR.size).fill(null);
    CR.brush = null;
    $("craft-hint").textContent = table
      ? "Crafting Table — full 3×3 grid. Tap an item, then tap the squares."
      : "2×2 crafting. Tap an item below, then a square. Make a table for tools!";
    renderCraft();
    showPanel("craft-panel");
  }
  Game._openCrafting = openCrafting; // (used by the smoke test)

  // Put every ingredient sitting in the grid back into the inventory.
  function returnGrid() {
    if (!CR.grid || !CR.grid.length) return;
    for (let i = 0; i < CR.grid.length; i++) {
      if (CR.grid[i]) { addItem(CR.grid[i], 1); CR.grid[i] = null; }
    }
  }

  // Tap a square: drop the brush in (consuming one from the inventory) or, if
  // the square is already full, take that ingredient back out.
  function tapCell(i) {
    if (CR.grid[i]) {
      addItem(CR.grid[i], 1);
      CR.grid[i] = null;
    } else if (CR.brush) {
      if (countItem(CR.brush) <= 0) { toast("You're out of " + Game.itemName(CR.brush) + "."); }
      else { removeItems({ [CR.brush]: 1 }); CR.grid[i] = CR.brush; }
    } else {
      toast("Pick an item below first.");
    }
    renderCraft();
  }

  // Auto-arrange a recipe in the grid from your inventory (the recipe book).
  function autoFill(r) {
    if (r.table && !CR.table) { toast("Make & place a Crafting Table, then tap it."); return; }
    const trimmed = r._trim || (r._trim = trimPattern(r.pattern));
    if (trimmed.length > CR.size || trimmed[0].length > CR.size) {
      toast("That needs a bigger (3×3) table."); return;
    }
    // Count what the recipe needs, including what's already in the grid.
    returnGrid();
    const need = {};
    trimmed.forEach((row) => row.forEach((id) => { if (id) need[id] = (need[id] || 0) + 1; }));
    for (const id in need) {
      if (countItem(id) < need[id]) {
        toast("Need " + need[id] + " " + Game.itemName(id) + "."); renderCraft(); return;
      }
    }
    // Place it (top-left aligned).
    for (let r2 = 0; r2 < trimmed.length; r2++) {
      for (let c2 = 0; c2 < trimmed[r2].length; c2++) {
        const id = trimmed[r2][c2];
        if (!id) continue;
        removeItems({ [id]: 1 });
        CR.grid[r2 * CR.size + c2] = id;
      }
    }
    renderCraft();
  }

  function doCraft() {
    const r = currentRecipe();
    if (!r) { toast("That doesn't make anything yet."); return; }
    // The ingredients were already taken from the inventory as they were placed,
    // so crafting just clears the grid and hands over the result.
    CR.grid.fill(null);
    addItem(r.gives.id, r.gives.count);
    toast("Crafted " + Game.itemName(r.gives.id) +
      (r.gives.count > 1 ? " x" + r.gives.count : "") + "!");
    renderCraft();
  }

  function renderCraft() {
    // The crafting grid.
    const grid = $("craft-grid");
    grid.style.gridTemplateColumns = "repeat(" + CR.size + ", 1fr)";
    grid.innerHTML = "";
    for (let i = 0; i < CR.size * CR.size; i++) {
      const cell = document.createElement("div");
      cell.className = "craft-cell" + (CR.grid[i] ? " filled" : "");
      if (CR.grid[i]) { cell.innerHTML = iconHTML(CR.grid[i]); cell.title = Game.itemName(CR.grid[i]); }
      cell.addEventListener("click", () => tapCell(i));
      grid.appendChild(cell);
    }

    // The result square.
    const r = currentRecipe();
    const res = $("craft-result");
    res.className = "craft-result" + (r ? " ready" : "");
    res.innerHTML = r
      ? iconHTML(r.gives.id) + (r.gives.count > 1 ? '<span class="count">' + r.gives.count + "</span>" : "")
      : "";
    res.title = r ? "Craft " + Game.itemName(r.gives.id) : "Result";

    // Your ingredients (tap to pick a brush).
    const inv = $("craft-inv");
    inv.innerHTML = "";
    const seen = {};
    S.inv.forEach((s) => { if (s) seen[s.id] = (seen[s.id] || 0) + s.count; });
    const ids = Object.keys(seen);
    if (!ids.length) {
      inv.innerHTML = '<span class="craft-empty">Collect some wood, stone or sticks to craft with.</span>';
    } else {
      ids.forEach((id) => {
        const chip = document.createElement("button");
        chip.className = "craft-chip" + (CR.brush === id ? " active" : "");
        chip.dataset.item = id;
        chip.innerHTML = iconHTML(id) + '<span class="count">' + seen[id] + "</span>";
        chip.title = Game.itemName(id);
        chip.addEventListener("click", () => { CR.brush = (CR.brush === id ? null : id); renderCraft(); });
        inv.appendChild(chip);
      });
    }

    // The recipe book — either the shaped table recipes or the furnace recipes,
    // depending on which tab is selected.
    renderRecipeBook();
  }

  // One row in a smelt-recipe list (shared by the crafting screen's furnace tab
  // and the furnace panel itself).
  function buildSmeltRecipeItem(inId, onClick) {
    const out = Game.SmeltRecipes[inId];
    const btn = document.createElement("button");
    btn.className = "recipe-book-item";
    btn.dataset.smelt = inId;
    btn.innerHTML =
      '<span class="rb-icon">' + iconHTML(out.id) + "</span>" +
      '<span class="rb-text"><b>' + Game.itemName(out.id) +
      (out.count > 1 ? " ×" + out.count : "") + "</b><br><small>🔥 " +
      Game.itemName(inId) + " → " + Game.itemName(out.id) + "</small></span>";
    btn.addEventListener("click", onClick);
    return btn;
  }

  // Two tabs in the crafting screen: shaped "Crafting" recipes (tap to fill the
  // grid) and a reference list of "Furnace" smelting recipes.
  function renderRecipeBook() {
    const book = $("recipe-book");
    const hint = $("recipe-book-hint");
    book.innerHTML = "";
    $("tab-craft").classList.toggle("active", CR.tab !== "furnace");
    $("tab-furnace").classList.toggle("active", CR.tab === "furnace");

    if (CR.tab === "furnace") {
      hint.textContent = "Smelt these at a furnace — place one and tap it.";
      Object.keys(Game.SmeltRecipes).forEach((inId) => {
        book.appendChild(buildSmeltRecipeItem(inId, () =>
          toast("Place a furnace and tap it to smelt " + Game.itemName(inId) + ". 🔥")));
      });
      return;
    }

    hint.textContent = "Tap a recipe to fill the grid.";
    Game.Recipes.forEach((rec) => {
      if (!rec._trim) rec._trim = trimPattern(rec.pattern);
      const tooBig = rec._trim.length > CR.size || rec._trim[0].length > CR.size;
      const needTable = rec.table && !CR.table;
      const btn = document.createElement("button");
      btn.className = "recipe-book-item";
      btn.dataset.recipe = rec.id;
      btn.disabled = tooBig || needTable;
      const cost = {};
      rec._trim.forEach((row) => row.forEach((id) => { if (id) cost[id] = (cost[id] || 0) + 1; }));
      const costStr = Object.keys(cost).map((id) => cost[id] + " " + Game.itemName(id)).join(" + ");
      btn.innerHTML =
        '<span class="rb-icon">' + iconHTML(rec.gives.id) + "</span>" +
        '<span class="rb-text"><b>' + Game.itemName(rec.gives.id) +
        (rec.gives.count > 1 ? " ×" + rec.gives.count : "") + "</b><br><small>" +
        costStr + (needTable ? " · needs a table" : "") + "</small></span>";
      btn.addEventListener("click", () => autoFill(rec));
      book.appendChild(btn);
    });
  }

  // ===============================================================
  //  Furnace — load a fuel (coal / battery) + something to smelt
  // ===============================================================
  const FUR = { fuel: null, fuelN: 0, input: null, inputN: 0, burn: 0, brush: null };
  S.furnace = FUR;

  function openFurnace() {
    returnFurnace();
    FUR.brush = null;
    renderFurnace();
    showPanel("furnace-panel");
  }
  Game._openFurnace = openFurnace; // (used by the smoke test)

  // Tip whatever is sitting in the furnace back into your inventory.
  function returnFurnace() {
    if (FUR.fuel && FUR.fuelN > 0) addItem(FUR.fuel, FUR.fuelN);
    if (FUR.input && FUR.inputN > 0) addItem(FUR.input, FUR.inputN);
    FUR.fuel = null; FUR.fuelN = 0; FUR.input = null; FUR.inputN = 0; FUR.burn = 0;
  }

  // Some items both burn AND smelt, so they can sit in both furnace slots at
  // once (splitting the stack to fuel the smelting of themselves).
  const dualUse = (id) => Game.isFuel(id) && Game.canSmelt(id);

  function furnaceFill(which) {
    const id = FUR.brush;
    // Slot bookkeeping so we can treat "fuel" and "input" the same way.
    const slot = which === "fuel" ? "fuel" : "input";
    const cnt = which === "fuel" ? "fuelN" : "inputN";
    const other = which === "fuel" ? "input" : "fuel";
    const otherCnt = which === "fuel" ? "inputN" : "fuelN";

    // Tapping a filled slot tips it back into your inventory.
    if (FUR[slot] && FUR[cnt] > 0) { addItem(FUR[slot], FUR[cnt]); FUR[slot] = null; FUR[cnt] = 0; renderFurnace(); return; }

    if (!id) { toast("Pick an item below first."); return; }
    if (which === "fuel" && !Game.isFuel(id)) { toast("That's not fuel — use coal or a battery."); return; }
    if (which === "input" && !Game.canSmelt(id)) { toast(Game.itemName(id) + " can't be smelted."); return; }

    const n = countItem(id);
    if (n > 0) {
      removeItems({ [id]: n }); FUR[slot] = id; FUR[cnt] = n;
    } else if (FUR[other] === id && FUR[otherCnt] >= 2) {
      // None left in your pack — split a dual-use item (coal) out of the other
      // slot so it can fuel the smelting of itself.
      const move = Math.floor(FUR[otherCnt] / 2);
      FUR[otherCnt] -= move; FUR[slot] = id; FUR[cnt] = move;
    } else {
      toast("You don't have any " + Game.itemName(id) + " left.");
      return;
    }
    renderFurnace();
  }

  function doSmelt() {
    if (!FUR.input || FUR.inputN <= 0) { toast("Add something to smelt."); return; }
    if (!Game.canSmelt(FUR.input)) { toast("That can't be smelted."); return; }
    const out = Game.SmeltRecipes[FUR.input];
    let made = 0;
    while (FUR.inputN > 0) {
      if (FUR.burn <= 0) {
        if (FUR.fuelN <= 0) break;          // out of fuel
        FUR.fuelN -= 1; FUR.burn += Game.fuelValue(FUR.fuel);
      }
      FUR.burn -= 1; FUR.inputN -= 1; made += 1;
      addItem(out.id, out.count);
    }
    if (FUR.inputN <= 0) FUR.input = null;
    if (FUR.fuelN <= 0 && FUR.burn <= 0) FUR.fuel = null;
    renderFurnace();
    if (!made) toast("Need fuel — add coal or a battery. 🔥");
    else toast("Smelted " + made + " × " + Game.itemName(out.id) + "!");
  }

  function renderFurnace() {
    const cell = (el, id, n) => {
      el.innerHTML = id ? iconHTML(id) + (n > 1 ? '<span class="count">' + n + "</span>" : "") : "";
    };
    cell($("furnace-fuel"), FUR.fuel, FUR.fuelN);
    cell($("furnace-input"), FUR.input, FUR.inputN);
    const out = FUR.input && Game.canSmelt(FUR.input) ? Game.SmeltRecipes[FUR.input] : null;
    const oc = $("furnace-output");
    oc.innerHTML = out ? iconHTML(out.id) : "";
    oc.className = "furnace-cell out" + (out && (FUR.fuelN > 0 || FUR.burn > 0) ? " ready" : "");
    $("furnace-burn").textContent = (FUR.fuel || FUR.burn > 0)
      ? "🔥 Fuel loaded: " + FUR.fuelN + (FUR.fuel ? " × " + Game.itemName(FUR.fuel) : "")
      : "No fuel loaded yet";

    const inv = $("furnace-inv");
    inv.innerHTML = "";
    const seen = {};
    S.inv.forEach((s) => { if (s) seen[s.id] = (seen[s.id] || 0) + s.count; });
    // Keep a dual-use item (coal) selectable even once it's loaded, so it can be
    // split into the other slot — letting it fuel the smelting of itself.
    if (FUR.fuel && dualUse(FUR.fuel)) seen[FUR.fuel] = (seen[FUR.fuel] || 0) + FUR.fuelN;
    if (FUR.input && dualUse(FUR.input)) seen[FUR.input] = (seen[FUR.input] || 0) + FUR.inputN;
    const ids = Object.keys(seen);
    if (!ids.length) {
      inv.innerHTML = '<span class="craft-empty">Gather sand, clay, coal or ore — and some fuel.</span>';
    } else {
      ids.forEach((id) => {
        const chip = document.createElement("button");
        chip.className = "craft-chip" + (FUR.brush === id ? " active" : "");
        chip.innerHTML = iconHTML(id) + '<span class="count">' + seen[id] + "</span>";
        chip.title = Game.itemName(id) + (Game.isFuel(id) ? " · fuel 🔥" : (Game.canSmelt(id) ? " · smeltable ♨️" : ""));
        chip.addEventListener("click", () => { FUR.brush = (FUR.brush === id ? null : id); renderFurnace(); });
        inv.appendChild(chip);
      });
    }

    // The same smelting recipes shown on the craft screen, right here in the
    // furnace. Tap one to load that ingredient straight into the smelt slot.
    const recBook = $("furnace-recipes");
    if (recBook) {
      recBook.innerHTML = "";
      Object.keys(Game.SmeltRecipes).forEach((inId) => {
        recBook.appendChild(buildSmeltRecipeItem(inId, () => loadSmeltRecipe(inId)));
      });
    }
  }

  // Tap a furnace recipe: if you have the ingredient (and the smelt slot is
  // free), load it ready to smelt; otherwise just say what you'd need.
  function loadSmeltRecipe(inId) {
    if (FUR.input && FUR.inputN > 0) { toast("The smelt slot is full — tap it to empty it first."); return; }
    if (countItem(inId) <= 0) { toast("You need some " + Game.itemName(inId) + " first."); return; }
    FUR.brush = inId;
    furnaceFill("input");
  }

  // ===============================================================
  //  Chest — extra storage you place in the world
  // ===============================================================
  function chestArr() {
    let a = S.chests[S.openChestKey];
    if (!a) { a = new Array(CHEST_SIZE).fill(null); S.chests[S.openChestKey] = a; }
    return a;
  }

  function openChest(pos) {
    S.openChestKey = pos.x + "," + pos.y + "," + pos.z;
    chestArr();
    renderChest();
    showPanel("chest-panel");
  }

  // Tip a broken chest's contents into your inventory so nothing is lost.
  function dumpChest(pos) {
    const k = pos.x + "," + pos.y + "," + pos.z;
    const a = S.chests[k];
    if (a) { a.forEach((s) => { if (s) addItem(s.id, s.count); }); delete S.chests[k]; }
  }

  function chestTake(i) {
    const a = chestArr(); const s = a[i]; if (!s) return;
    const fit = addItem(s.id, s.count); s.count -= fit; if (s.count <= 0) a[i] = null;
    renderChest();
  }
  function chestPut(i) {
    const s = S.inv[i]; if (!s) return;
    const a = chestArr(); const fit = stackInto(a, s.id, s.count);
    s.count -= fit; if (s.count <= 0) S.inv[i] = null;
    renderHotbar(); renderChest();
  }

  function renderChest() {
    const fill = (grid, arr, onClick) => {
      grid.innerHTML = "";
      for (let i = 0; i < arr.length; i++) {
        const el = document.createElement("div");
        el.className = "slot";
        const s = arr[i];
        if (s) { el.innerHTML = iconHTML(s.id) + (showSlotCount(s) ? '<span class="count">' + s.count + "</span>" : ""); el.title = Game.itemName(s.id); }
        el.addEventListener("click", () => onClick(i));
        grid.appendChild(el);
      }
    };
    fill($("chest-grid"), chestArr(), chestTake);
    fill($("chest-inv-grid"), S.inv, chestPut);
  }

  // ===============================================================
  //  Villager trading
  // ===============================================================
  function openTrade(villager) {
    S.tradingWith = villager;
    renderTrades();
    showPanel("trade-panel");
  }
  Game._openTrade = openTrade; // (used by the smoke test)
  function buyTrade(t) {
    if (countItem("emerald") < t.cost) { toast("You need " + t.cost + " emerald" + (t.cost > 1 ? "s" : "") + " for that."); return; }
    removeItems({ emerald: t.cost });
    addItem(t.gives.id, t.gives.count);
    toast("Traded for " + Game.itemName(t.gives.id) + "! 💚");
    renderTrades();
  }
  // The quest villagers each offer one special key (the third wants netherite).
  // Each key can be obtained only once — a villager won't hand out a second.
  function questKeyClaimed(q) {
    return !!S.questKeysGiven[q.gives] || countItem(q.gives) > 0;
  }
  function buyQuest(q) {
    if (questKeyClaimed(q)) {
      toast("The villager has already given you the " + Game.itemName(q.gives) + ".");
      return;
    }
    if (q.cost && countItem(q.cost.id) < q.cost.count) {
      toast("You need " + q.cost.count + " " + Game.itemName(q.cost.id) + " for that key.");
      return;
    }
    if (q.cost) removeItems({ [q.cost.id]: q.cost.count });
    addItem(q.gives, 1);
    S.questKeysGiven[q.gives] = true;   // remember it: one key per villager, ever
    toast("Traded for the " + Game.itemName(q.gives) + "! 🗝️");
    renderTrades();
  }
  Game._buyQuest = buyQuest; // (used by the quest test)

  function renderTrades() {
    $("trade-emeralds").textContent = "💚 Your emeralds: " + countItem("emerald");
    const list = $("trade-list");
    list.innerHTML = "";

    // A quest villager's key trade sits at the top, highlighted.
    const q = S.tradingWith && S.tradingWith.userData && S.tradingWith.userData.quest;
    if (q) {
      const btn = document.createElement("button");
      btn.className = "recipe-book-item quest-trade";
      const claimed = questKeyClaimed(q);
      const canBuy = !q.cost || countItem(q.cost.id) >= q.cost.count;
      btn.disabled = claimed || !canBuy;
      const costText = claimed
        ? "already received — one per villager"
        : (q.cost ? ("needs " + q.cost.count + " " + Game.itemName(q.cost.id))
                   : "a gift — just take it!");
      btn.innerHTML =
        '<span class="rb-icon">' + iconHTML(q.gives) + "</span>" +
        '<span class="rb-text"><b>🗝️ ' + Game.itemName(q.gives) +
        (claimed ? " ✓" : "") + "</b><br><small>" + costText + "</small></span>";
      btn.addEventListener("click", () => buyQuest(q));
      list.appendChild(btn);
    }

    Game.Trades.forEach((t) => {
      const btn = document.createElement("button");
      btn.className = "recipe-book-item";
      btn.disabled = countItem("emerald") < t.cost;
      btn.innerHTML =
        '<span class="rb-icon">' + iconHTML(t.gives.id) + "</span>" +
        '<span class="rb-text"><b>' + Game.itemName(t.gives.id) +
        (t.gives.count > 1 ? " ×" + t.gives.count : "") + "</b><br><small>" +
        t.cost + " 💚 emerald" + (t.cost > 1 ? "s" : "") + "</small></span>";
      btn.addEventListener("click", () => buyTrade(t));
      list.appendChild(btn);
    });
  }

  // ===============================================================
  //  Riding an animal (fences keep them penned)
  // ===============================================================
  function toggleRide(animal) {
    S.riding = animal;
    toast("Riding the " + (animal.userData.kind || "animal") + "! Tap to hop off. 🐎");
  }
  function dismount() {
    S.riding = null;
    S.player.fallPeak = S.player.pos.y;  // you're standing where you stopped
  }
  function updateRiding(dt) {
    const p = S.player, a = S.riding;
    if (!a) return;
    // Ride with the exact same controls as walking: drag to look/steer, the
    // forward button to walk, and jump to jump. The player moves normally and
    // the mount is carried right along underneath them.
    p.update(dt, S.input);
    a.position.set(p.pos.x, p.pos.y, p.pos.z);
    const f = p.forwardH();
    a.rotation.y = -Math.atan2(f.z, f.x) + Math.PI / 2; // face the way you steer
  }
  Game._updateRiding = updateRiding; // (used by the feature test)

  // Tapping an animal mounts it (or trades with a villager). Returns true if it
  // handled the tap.
  function aimedEntityAct() {
    const hit = S.world.raycast(S.player.eyePosition(), S.player.lookDir());
    let blockDist = null;
    if (hit) {
      const c = new THREE.Vector3(hit.block.x + 0.5, hit.block.y + 0.5, hit.block.z + 0.5);
      blockDist = S.player.eyePosition().distanceTo(c);
    }
    const animal = aimedAnimal(blockDist);
    if (!animal) return false;
    const kind = animal.userData.kind;
    if (kind === "villager") openTrade(animal);
    else if (kind === "piglin") tradePiglin(animal);
    else if (kind === "wither") toast("💀 The Wither! Keep your distance from its skulls.");
    else if (kind === "skeleton") toast("🏹 A skeleton archer! Armour or a shield blocks its arrows.");
    else if (kind === "zombie") toast("🧟 A zombie! Don't let it bump into you.");
    else toggleRide(animal);
    S.swing = 0.18;
    return true;
  }

  // Tap a piglin holding a gold ingot to trade it away for a random treasure:
  // a diamond, an emerald, or (a lucky day!) a piece of netherite.
  function tradePiglin(piglin) {
    if (countItem("gold_ingot") < 1) {
      toast("The piglin grunts and eyes your hands — trade it a 🪙 gold ingot!");
      return;
    }
    removeItems({ gold_ingot: 1 });
    const pool = ["diamond", "emerald", "netherite"];
    const got = pool[Math.floor(Math.random() * pool.length)];
    addItem(got, 1);
    const emoji = got === "netherite" ? "🖤" : (got === "diamond" ? "💎" : "💚");
    toast("The piglin snorts and hands you a " + Game.itemName(got) + "! " + emoji);
    renderHotbar(); updateHand();
  }

  // Tapping an interactive block (table / furnace / chest / door / window).
  function tryBlockInteract(hit) {
    if (!hit) return false;
    const id = S.world.get(hit.block.x, hit.block.y, hit.block.z);
    if (id === "crafting_table") { openCrafting(true); return true; }
    if (id === "furnace") { openFurnace(); return true; }
    if (id === "chest") { openChest(hit.block); return true; }
    if (id === "credits_block") { showCredits(); return true; }
    if (id === "nether_portal" || id === "end_portal") { return true; } // step in to travel
    if (id === "end_frame") { insertEnderEye(hit.block); return true; }
    if (id === "end_frame_eye") { removeEnderEye(hit.block); return true; }
    if (Game.LOCKED[id]) { tryUnlock(hit.block); return true; }
    if (Game.OPENABLE[id]) {
      S.world.setBlock(hit.block.x, hit.block.y, hit.block.z, Game.OPENABLE[id]);
      S.swing = 0.18;
      return true;
    }
    return false;
  }

  // ===============================================================
  //  The End Gate: 8 Eyes of Ender light the portal in the 4th house
  // ===============================================================
  // Tap an empty frame socket while carrying an Eye of Ender to set it in.
  // When the 8th eye clicks into place, the portal blazes to life.
  function insertEnderEye(block) {
    S.swing = 0.18;
    if (countItem("eye_of_ender") < 1) {
      toast("🧿 An empty eye socket… an Eye of Ender would fit. They say a Nether fortress chest holds eight of them.");
      return;
    }
    removeItems({ eye_of_ender: 1 });
    S.world.setBlock(block.x, block.y, block.z, "end_frame_eye");
    const n = S.world.endGateEyes();
    if (n >= 8) {
      S.world.setEndGateActive(true);
      toast("✨ The 8th Eye clicks into place — the End Portal roars to life! Step through when you're ready…");
    } else {
      toast("🧿 Eye of Ender placed — " + n + " of 8.");
    }
    renderHotbar(); updateHand();
  }

  // Tap a filled socket to pop its eye back out — and darken the portal.
  function removeEnderEye(block) {
    S.swing = 0.18;
    const wasLit = S.world.endGateEyes() >= 8;
    S.world.setBlock(block.x, block.y, block.z, "end_frame");
    addItem("eye_of_ender", 1);
    if (wasLit) {
      S.world.setEndGateActive(false);
      toast("🧿 The Eye pops out and the portal fades dark — " + S.world.endGateEyes() + " of 8.");
    } else {
      toast("🧿 Took the Eye of Ender back — " + S.world.endGateEyes() + " of 8.");
    }
    renderHotbar(); updateHand();
  }

  Game._insertEnderEye = insertEnderEye;   // (used by the tests)
  Game._removeEnderEye = removeEnderEye;

  // ===============================================================
  //  Locked doors, the credits plaque, and the Nether portal
  // ===============================================================
  // Tap a locked door with its matching key to open it for good.
  function tryUnlock(block) {
    const id = S.world.get(block.x, block.y, block.z);
    const houseNum = Game.LOCKED[id];
    if (!houseNum) return;
    const keyId = "key" + houseNum;
    S.swing = 0.18;
    if (countItem(keyId) > 0) {
      removeItems({ [keyId]: 1 });
      S.world.setBlock(block.x, block.y, block.z, "door_open");
      if (houseNum === 4) toast("🔓 The Gold Key opens the fourth house — a portal to The End glows within! ✨");
      else toast("🔓 Unlocked with the " + Game.itemName(keyId) + "!");
    } else {
      toast("🔒 Locked! Trade a villager for the " + Game.itemName(keyId) + ".");
    }
  }

  function showCredits(ending) {
    S.creditsEnding = !!ending;
    // Restart the scroll from the bottom each time it's opened.
    const scroll = $("credits-scroll");
    if (scroll) { scroll.style.animation = "none"; void scroll.offsetWidth; scroll.style.animation = ""; }
    showPanel("credits-panel");
    // When the winning credits finish rolling, drop back to the Home Screen —
    // "…and then that's it." (You can also press Close to skip there sooner.)
    // `once` auto-removes the listener so it can't linger or stack across games.
    if (ending && scroll) {
      scroll.addEventListener("animationend", function onEnd() {
        if (S.creditsEnding) returnToHome();
      }, { once: true });
    }
  }

  // You stepped through the Exit Portal — you win! Roll the celebratory credits.
  function winTheGame() {
    if (S.won) return;               // guard so we only fire once
    S.won = true;
    S.portalCooldown = 5;
    toast("🎉 You crafted the Exit Portal and escaped The End — you win! 🏆");
    showCredits(true);
  }
  Game._winTheGame = winTheGame;     // (used by the tests)

  // After the winning credits, return to the title/Home Screen. We deliberately
  // leave S.inEnd set until a world is actually (re)started, so saving stays
  // disabled — a stray pagehide can't write End coordinates into the overworld
  // save. Pressing Continue reloads the overworld right where you left it (by the
  // fourth house); startWorld() clears the End bookkeeping.
  function returnToHome() {
    S.creditsEnding = false;
    hideAllPanels();
    refreshStartPanel();
    showPanel("start-panel");
  }

  // Build (once) and switch the active scene to a world, moving the camera (and
  // its held-item viewmodel) and the player's collision world along with it.
  function buildWorldScene(world) {
    if (world._scene) return;
    const scene = buildScene(world.biome);
    world.scene = scene;
    world.material = world.material || new THREE.MeshLambertMaterial({ vertexColors: true });
    world.buildMeshes();
    world.animals.forEach((a) => scene.add(a));
    world._scene = scene;
    world._highlight = buildHighlight(scene);
  }

  function activateWorld(world, spawn) {
    buildWorldScene(world);
    if (S.camera.parent) S.camera.parent.remove(S.camera);
    world._scene.add(S.camera);
    S.world = world;
    S.scene = world._scene;
    S.highlight = world._highlight;
    S.player.world = world;
    if (spawn) {
      S.player.pos.set(spawn.x, spawn.y, spawn.z);
      S.player.vel.set(0, 0, 0);
      S.player.fallPeak = spawn.y;
      S.player.syncCamera();
    }
  }

  // Build the Nether world (once), and prepare its scene so blocks added to it
  // later (e.g. a linked portal) can re-mesh even before you first step through.
  function ensureNether() {
    if (!S.netherWorld) {
      const nw = new Game.World(null, S.overworld.seed, "nether", S.overworld.legacy);
      nw.generateNether();
      S.netherWorld = nw;
      buildWorldScene(nw);       // give it a scene so edits re-mesh safely
      prefillNetherChests(nw);   // stock the fortress chest with netherite
    }
    return S.netherWorld;
  }
  Game._ensureNether = ensureNether;   // (used by the tests)

  // Stock each Nether fortress chest with treasure — but only if the player
  // hasn't already opened it (a saved chest key means "leave it as they left it").
  function prefillNetherChests(nw) {
    (nw.fortressChests || []).forEach((c) => {
      const key = c.x + "," + c.y + "," + c.z;
      if (key in S.chests) return;
      // Loot: netherite, gems, and a spread of good blocks to build with — and
      // in the open worlds, the 8 Eyes of Ender that light the End Portal.
      const loot = [];
      if (!S.overworld.legacy) loot.push({ id: "eye_of_ender", count: 8 });
      loot.push(
        { id: "netherite", count: 3 },
        { id: "diamond", count: 5 },
        { id: "emerald", count: 5 },
        { id: "glowstone", count: 12 },   // good light block
        { id: "obsidian", count: 8 },     // good sturdy block
        { id: "gold_ore", count: 6 },     // good shiny block
        { id: "gold_ingot", count: 4 }    // some gold to trade with the piglin
      );
      const arr = new Array(CHEST_SIZE).fill(null);
      loot.forEach((it, i) => { arr[i] = it; });
      S.chests[key] = arr;
    });
  }

  // Stock the woodland mansion's two chests with treasure — but only if the
  // player hasn't already opened them (a saved key means "leave it as found").
  function prefillMansionChests(world) {
    (world.mansionChests || []).forEach((c, i) => {
      const key = c.x + "," + c.y + "," + c.z;
      if (key in S.chests) return;
      // Ground floor: useful supplies. Upstairs: the real treasure.
      const loot = i === 0
        ? [
            { id: "emerald", count: 6 },
            { id: "torch", count: 8 },
            { id: "apple", count: 4 },
            { id: "bricks", count: 12 },
            { id: "book", count: 1 }
          ]
        : [
            { id: "totem", count: 1 },           // the mansion's unique treasure
            { id: "diamond", count: 4 },
            { id: "diamond_chestplate", count: 1 },
            { id: "gold_ingot", count: 3 },
            { id: "glowstone", count: 6 },
            { id: "battery", count: 1 }
          ];
      const arr = new Array(CHEST_SIZE).fill(null);
      loot.forEach((it, j) => { arr[j] = it; });
      S.chests[key] = arr;
    });
  }

  // The first settlement's starter chest: a friendly welcome kit.
  function prefillStarterChest(world) {
    const c = world.starterChest;
    if (!c) return;
    const key = c.x + "," + c.y + "," + c.z;
    if (key in S.chests) return;
    const loot = [
      { id: "pickaxe", count: 1 },
      { id: "apple", count: 5 },
      { id: "torch", count: 6 },
      { id: "wood", count: 8 },
      { id: "stick", count: 4 },
      { id: "bed", count: 1 }
    ];
    const arr = new Array(CHEST_SIZE).fill(null);
    loot.forEach((it, i) => { arr[i] = it; });
    S.chests[key] = arr;
  }

  // A ghast fires only once per Nether visit; re-arm every ghast on entry.
  function resetGhasts(world) {
    world.animals.forEach((a) => {
      if (a.userData.kind === "ghast") {
        a.userData.hasFired = false;
        a.userData.fireTimer = 2 + Math.random() * 3;
      }
    });
  }

  function travelToNether(spawn) {
    ensureNether();
    activateWorld(S.netherWorld, spawn || S.netherWorld.spawn);
    S.inNether = true;
    S.portalCooldown = 2;
    resetGhasts(S.netherWorld);
    toast("🔥 Into the Nether! Trade the piglin gold — and dodge the ghasts' fire!");
  }

  function travelToOverworld(spawn) {
    activateWorld(S.overworld, spawn || S.questPortalExit || S.overworld.spawn);
    S.inNether = false;
    S.portalCooldown = 2;
    toast("🌳 Back to the overworld!");
  }

  // Thin wrappers kept for the quest's built-in portals (no player-made link).
  function enterNether() { travelToNether(S.netherWorld ? S.netherWorld.spawn : null); }
  function exitNether() { travelToOverworld(); }

  // ---- The End --------------------------------------------------------------
  // Built once, the first time you step through the fourth house's portal. There
  // is NO portal back to the overworld: the only way out is the Exit Portal you
  // craft from four End Crystals — and stepping through THAT wins the game.
  function ensureEnd() {
    if (!S.endWorld) {
      const ew = new Game.World(null, (S.overworld.seed ^ 0x3e4d) >>> 0, "end", S.overworld.legacy);
      ew.generateEnd();
      S.endWorld = ew;
      buildWorldScene(ew);
    }
    return S.endWorld;
  }

  // Slip a full suit of diamond armour onto anyone who arrives unprotected, so
  // the dragon's purple fire really can't touch you (as promised).
  function grantEndArmor() {
    if (hasDefense()) return;
    ["helmet", "chestplate", "leggings", "boots"].forEach((slot) => {
      if (!S.equip[slot]) S.equip[slot] = "diamond_" + slot;
    });
    updateOffhand();
  }

  function travelToEnd() {
    ensureEnd();
    activateWorld(S.endWorld, S.endWorld.spawn);
    S.inEnd = true;
    S.portalCooldown = 2;
    grantEndArmor();
    toast("✨ Into The End! You're clad in armour — brave the dragon's purple fire, climb the four spires for the End Crystals.");
  }

  // ---- Linked portals -------------------------------------------------------
  // Each portal a player lights in the overworld opens onto a FRESH portal at a
  // random spot in the Nether (never the pre-existing one). We remember the pair
  // so walking in travels to the right place, and destroying the overworld
  // portal tears its Nether twin down too.
  function findLinkByOw(id) { return S.portalLinks.find((l) => l.owId === id) || null; }
  function findLinkByNe(id) { return S.portalLinks.find((l) => l.neId === id) || null; }

  // When a portal is lit in the overworld, carve its twin into the Nether.
  function linkNewOverworldPortal(owCells) {
    const owId = Game.World.portalId(owCells);
    if (findLinkByOw(owId)) return;               // already linked
    ensureNether();
    const nw = S.netherWorld;
    const spot = nw.findNetherPortalSpot();
    const made = nw.openNetherPortalAt(spot.x, spot.z);
    // Where you land coming back: the overworld portal's lowest cell.
    let low = null;
    owCells.forEach((k) => { const p = k.split(",").map(Number); if (!low || p[1] < low[1]) low = p; });
    const owReturn = { x: low[0] + 0.5, y: low[1], z: low[2] + 0.5 };
    S.portalLinks.push({
      owId: owId,
      neId: Game.World.portalId(made.cells),
      neSpawn: made.spawn,
      owReturn: owReturn
    });
  }

  // Standing in a portal block carries you between the worlds. Player-lit portals
  // travel to their own linked twin; the quest's built-in portals fall back to
  // the default spawn / return cell.
  function handlePortal(dt) {
    if (S.portalCooldown > 0) { S.portalCooldown -= dt; return; }
    const p = S.player.pos;
    const bx = Math.floor(p.x), by = Math.floor(p.y + 0.2), bz = Math.floor(p.z);
    const pid = S.world.get(bx, by, bz);
    // The crafted Exit Portal ends the game; the End portal carries you into The
    // End (there's no reverse — the End has no portal home).
    if (pid === "exit_portal") { winTheGame(); return; }
    if (pid === "end_portal") { if (!S.inEnd) travelToEnd(); return; }
    if (pid !== "nether_portal") return;
    const id = Game.World.portalId(S.world.portalCellsFrom(bx, by, bz));
    if (!S.inNether) {
      const link = findLinkByOw(id);
      if (link) travelToNether(link.neSpawn);
      else enterNether();
    } else {
      const link = findLinkByNe(id);
      if (link) travelToOverworld(link.owReturn);
      else exitNether();
    }
  }

  // ===============================================================
  //  Eating
  // ===============================================================
  function eatFood() {
    // Eat the held item if it's food; otherwise eat the first food we're carrying.
    const sel = selectedSlot();
    let id = sel && Game.itemDef(sel.id) && Game.itemDef(sel.id).food ? sel.id : null;
    if (!id) {
      for (const s of S.inv) {
        if (s && Game.itemDef(s.id) && Game.itemDef(s.id).food) { id = s.id; break; }
      }
    }
    if (!id) { toast("No food to eat. Find apples or watermelon!"); return; }
    if (S.player.food >= C.MAX_FOOD) { toast("You're full!"); return; }
    removeItems({ [id]: 1 });
    S.player.eat(Game.itemDef(id).food);
    renderHotbar();
    updateHand();
    setViewmodel(selectedSlot() ? selectedSlot().id : null);
    toast("Yum! " + (Game.itemDef(id).emoji || "😋"));
  }

  // ===============================================================
  //  Actions: place, mine, punch
  // ===============================================================
  function placeOverlapsPlayer(cx, cy, cz) {
    const p = S.player.pos, h = C.P_HALF;
    return (
      cx + 1 > p.x - h && cx < p.x + h &&
      cz + 1 > p.z - h && cz < p.z + h &&
      cy + 1 > p.y && cy < p.y + C.P_HEIGHT
    );
  }

  function aimedAnimal(blockDist) {
    if (!S.world.animals.length) return null;
    S.raycaster.setFromCamera(new THREE.Vector2(0, 0), S.camera);
    S.raycaster.far = C.REACH;
    const hits = S.raycaster.intersectObjects(S.world.animals, true);
    if (!hits.length) return null;
    if (blockDist != null && hits[0].distance > blockDist) return null;
    // find the root animal group
    let o = hits[0].object;
    while (o.parent && S.world.animals.indexOf(o) === -1) o = o.parent;
    return o;
  }

  function doUse() {
    if (S.riding) { dismount(); return; }
    const s = selectedSlot();
    const hit = S.world.raycast(S.player.eyePosition(), S.player.lookDir());
    const holdingPick = s && Game.isPickaxe(s.id);

    // Aiming at an interactive block (table / furnace / chest / door) uses it —
    // even with a block in your hand — so selecting one never places onto it.
    if (!holdingPick && tryBlockInteract(hit)) return;

    // Water bucket: pour ONE water out per tap. The bucket keeps the rest of
    // its waters; only when the very last one is poured does it empty back into
    // a plain bucket.
    if (s && s.id === "water_bucket") {
      if (!hit) { toast("Aim at a block to pour water on."); return; }
      // Water poured onto lava cools it into obsidian.
      if (S.world.get(hit.block.x, hit.block.y, hit.block.z) === "lava") {
        S.world.setBlock(hit.block.x, hit.block.y, hit.block.z, "obsidian");
        s.count -= 1;
        if (s.count <= 0) {
          S.inv[S.selected] = { id: "bucket", count: 1 };
          toast("The water cooled the lava into obsidian! 🪨 The bucket is empty now.");
        } else {
          toast("The water cooled the lava into obsidian! 🪨 — " + s.count + " 💧 left");
        }
        renderHotbar(); updateHand();
        setViewmodel(selectedSlot() ? selectedSlot().id : null);
        S.swing = 0.18;
        return;
      }
      const c = hit.place;
      if (S.world.occupied(c.x, c.y, c.z)) return;
      if (placeOverlapsPlayer(c.x, c.y, c.z)) { toast("No room to pour water here."); return; }
      S.world.setBlock(c.x, c.y, c.z, "water");
      s.count -= 1;
      if (s.count <= 0) {
        S.inv[S.selected] = { id: "bucket", count: 1 }; // emptied — left holding the bucket
        toast("The bucket is empty now.");
      } else {
        toast("Poured water — " + s.count + " 💧 left");
      }
      renderHotbar(); updateHand();
      setViewmodel(selectedSlot() ? selectedSlot().id : null);
      S.swing = 0.18;
      return;
    }

    // Flint & steel: tap an obsidian portal frame to light it. If the obsidian
    // rings a flat pocket of air, that air fills with glowing portal blocks.
    if (s && s.id === "flint_and_steel") {
      S.swing = 0.18;
      const target = hit && S.world.get(hit.block.x, hit.block.y, hit.block.z);
      if (target !== "obsidian") {
        toast("Aim at an obsidian portal frame to light it. 🔥");
        return;
      }
      const litCells = S.world.lightPortal(hit.block.x, hit.block.y, hit.block.z);
      if (litCells) {
        // A portal lit in the overworld opens a brand-new twin somewhere in the
        // Nether (rather than reusing the one that's already there).
        if (!S.inNether) linkNewOverworldPortal(litCells);
        toast("Whoosh! The portal flares to life. 🔥 Step in to reach the Nether!");
      } else {
        toast("Build a complete obsidian frame first, then light the inside. 🔥");
      }
      return;
    }

    // Holding a placeable block -> build.
    if (s && Game.itemDef(s.id) && Game.itemDef(s.id).placeable) {
      if (!hit) { toast("Aim at a block to build on."); return; }
      const def = Game.itemDef(s.id);
      const blockId = def.places || s.id;   // a water bucket lays down "water"
      const c = hit.place;
      if (S.world.occupied(c.x, c.y, c.z)) return;
      if (placeOverlapsPlayer(c.x, c.y, c.z)) { toast("No room to place that here."); return; }
      S.world.setBlock(c.x, c.y, c.z, blockId);
      s.count -= 1;
      if (s.count <= 0) S.inv[S.selected] = null;
      if (def.empties) addItem(def.empties, 1); // the bucket comes back empty
      renderHotbar(); updateHand();
      setViewmodel(selectedSlot() ? selectedSlot().id : null);
      S.swing = 0.18;
      return;
    }

    toast("Pick a block from your hotbar to build.");
  }

  function doHit() {
    if (S.riding) { dismount(); return; }

    // Animals come first if they're closer — tap to ride (or trade).
    if (aimedEntityAct()) return;

    const hit = S.world.raycast(S.player.eyePosition(), S.player.lookDir());
    if (!hit) return;
    const id = S.world.get(hit.block.x, hit.block.y, hit.block.z);
    const def = Game.BlockDefs[id];
    if (!def) return;
    S.swing = 0.18;

    // Quest fixtures can't be mined away — they're used, not broken.
    if (Game.LOCKED[id]) { tryUnlock(hit.block); return; }
    if (id === "credits_block") { showCredits(); return; }
    if (id === "nether_portal") return; // travel by walking into it
    // The End Gate: a mining swing pops an eye out, but the frame and the
    // portal itself can never be broken.
    if (id === "end_frame_eye") { removeEnderEye(hit.block); return; }
    if (id === "end_frame" || id === "end_portal") {
      toast("🧿 The End Portal frame is ancient magic — only Eyes of Ender go in and out.");
      return;
    }
    // Clouds float far out of reach and can't be broken — just a puff of air.
    if (id === "cloud") { toast("☁️ You can't mine the clouds — they're just fluffy sky!"); return; }

    // Only the final house is sealed: its walls, roof and floor can't be mined.
    // (In legacy worlds that keeps the winning screen behind the last key; in
    // new worlds it keeps the End Portal's room standing.)
    if (S.world.isProtected(hit.block.x, hit.block.y, hit.block.z)) {
      toast(S.world.legacy
        ? "🏆 This is the Hall of Fame — win the last key to get in, not a pickaxe."
        : "🏆 The fourth house is ancient magic — its walls can't be mined.");
      return;
    }

    // Water can only be picked up with a bucket. A water bucket keeps a running
    // count of how many waters it holds and can scoop up an unlimited amount.
    if (id === "water") {
      const sel = selectedSlot();
      if (sel && sel.id === "water_bucket") {
        sel.count += 1;                       // top up the bucket you're holding
        S.world.setBlock(hit.block.x, hit.block.y, hit.block.z, null);
        renderHotbar(); updateHand();
        toast("Collected water — " + sel.count + " 💧 in the bucket");
      } else if (sel && sel.id === "bucket") {
        sel.count -= 1;
        if (sel.count <= 0) S.inv[S.selected] = null;
        collectWater(1);
        S.world.setBlock(hit.block.x, hit.block.y, hit.block.z, null);
        renderHotbar(); updateHand();
        setViewmodel(selectedSlot() ? selectedSlot().id : null);
        toast("Scooped up water! 🪣");
      } else {
        toast("You need a 🪣 bucket to scoop up water.");
      }
      return;
    }

    // Lava is far too hot to pick up — but pour a bucket of water onto it and it
    // cools into obsidian.
    if (id === "lava") {
      toast("🔥 The lava's too hot to grab! Pour water on it to make obsidian.");
      return;
    }

    const holdingPick = selectedSlot() && Game.isPickaxe(selectedSlot().id);

    // Tapping an interactive block (without a pickaxe) uses it instead of
    // breaking it. Hold a pickaxe to actually mine these away.
    if (!holdingPick && tryBlockInteract(hit)) return;

    // Stone & ores need a pickaxe.
    if (def.tool === "pickaxe" && !holdingPick) {
      toast("You need a pickaxe to mine " + def.name + "!");
      return;
    }

    // A broken chest spills its contents back to you.
    if (id === "chest") dumpChest(hit.block);

    S.world.setBlock(hit.block.x, hit.block.y, hit.block.z, null);
    if (def.drop) {
      addItem(def.drop, 1);
      toast("+1 " + Game.itemName(def.drop));
    }

    // Removing obsidian that framed a portal snuffs that portal's purple light —
    // and if it was a player-lit overworld portal, its Nether twin winks out too.
    if (id === "obsidian") onObsidianRemoved(hit.block.x, hit.block.y, hit.block.z);
  }

  // Snuff any portal that lost its frame when this obsidian was mined, and tear
  // down the matching portal in the other dimension for a player-lit pair.
  function onObsidianRemoved(x, y, z) {
    const broken = S.world.snuffBrokenPortals(x, y, z);
    if (!broken.length) return;
    let toldTwin = false;
    broken.forEach((b) => {
      const link = S.inNether ? findLinkByNe(b.id) : findLinkByOw(b.id);
      if (link) {
        // Snuff the twin's portal cells in the other world.
        const twinWorld = S.inNether ? S.overworld : S.netherWorld;
        const twinId = S.inNether ? link.owId : link.neId;
        snuffPortalById(twinWorld, twinId);
        S.portalLinks = S.portalLinks.filter((l) => l !== link);
        toldTwin = true;
      }
    });
    if (toldTwin) toast("The portal goes dark — its twin fades away too. 🌑");
    else toast("The portal's purple light fizzles out. 🌑");
  }

  // Delete every nether_portal cell of the portal identified by `id` in `world`.
  function snuffPortalById(world, id) {
    if (!world || !id) return;
    const p = id.split(",").map(Number);
    if (world.get(p[0], p[1], p[2]) !== "nether_portal") return;
    world.portalCellsFrom(p[0], p[1], p[2]).forEach((k) => {
      const c = k.split(",").map(Number);
      world.setBlock(c[0], c[1], c[2], null);
    });
  }

  // A tap on the world acts on whatever the crosshair is pointing at.
  // Trees, leaves, cactus and apples are *always* grabbed/punched — even with a
  // block in your hand — so holding a block never turns "punch the tree" into an
  // accidental "place". You build by tapping the ground (or with the Place
  // button). Empty hand / pickaxe on anything else digs or mines.
  function doTap() {
    if (S.riding) { dismount(); return; }
    if (aimedEntityAct()) return; // tap an animal to ride / a villager to trade
    const hit = S.world.raycast(S.player.eyePosition(), S.player.lookDir());
    if (hit) {
      const id = S.world.get(hit.block.x, hit.block.y, hit.block.z);
      if (Game.harvestOnTap(id)) { doHit(); return; }
      // Doors / windows / table / furnace / chest / locks / plaque are used by a tap.
      if (id === "crafting_table" || id === "furnace" || id === "chest" || Game.OPENABLE[id] ||
          Game.LOCKED[id] || id === "credits_block" || id === "nether_portal") {
        tryBlockInteract(hit); return;
      }
    }
    const s = selectedSlot();
    // Flint & steel is a "use" tool, not a mining one — a tap should light a
    // portal frame, never try to break the obsidian it's aimed at.
    if (s && s.id === "flint_and_steel") { doUse(); return; }
    if (s && Game.itemDef(s.id) && Game.itemDef(s.id).placeable) doUse();
    else doHit();
  }

  // ===============================================================
  //  Viewmodel (the item shown in your hand)
  // ===============================================================
  // A little shield model tinted by its material, for the hand / offhand.
  function buildShieldMesh(id) {
    const def = Game.itemDef(id) || {};
    const light = def.swatch !== undefined ? def.swatch : 0x9aa0a8;
    const dark = def.swatchSide !== undefined ? def.swatchSide : Game.mix(light, 0x000000, 0.4);
    const g = new THREE.Group();
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.54, 0.04),
      new THREE.MeshLambertMaterial({ color: dark }));           // dark rim / back
    back.position.z = -0.02; g.add(back);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.46, 0.06),
      new THREE.MeshLambertMaterial({ color: light }));          // bright face
    g.add(plate);
    const boss = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.08),
      new THREE.MeshLambertMaterial({ color: dark }));           // centre boss
    boss.position.z = 0.04; g.add(boss);
    return g;
  }

  // Show an equipped shield in your left hand (empty otherwise), so you can see
  // when you're carrying it into a fight.
  function updateOffhand() {
    const oh = S.offhand;
    if (!oh) return;
    while (oh.children.length) oh.remove(oh.children[0]);
    if (S.equip && S.equip.shield) oh.add(buildShieldMesh(S.equip.shield));
  }
  Game._updateOffhand = updateOffhand;

  function setViewmodel(id) {
    const vm = S.viewmodel;
    while (vm.children.length) vm.remove(vm.children[0]);

    if (!id) {
      const fist = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.4),
        new THREE.MeshLambertMaterial({ color: 0xe0a878 }));
      vm.add(fist);
      return;
    }
    if (Game.isBlock(id)) {
      const mesh = new THREE.Mesh(blockGeo(id), S.world.material);
      mesh.scale.set(0.4, 0.4, 0.4);
      vm.add(mesh);
      return;
    }
    if (Game.isShield && Game.isShield(id)) {
      vm.add(buildShieldMesh(id));
      return;
    }
    if (id === "pickaxe" || id === "stone_pickaxe") {
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08),
        new THREE.MeshLambertMaterial({ color: 0x7a5a30 }));
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.1, 0.1),
        new THREE.MeshLambertMaterial({ color: id === "stone_pickaxe" ? 0x808086 : 0xb78a52 }));
      head.position.y = 0.22;
      vm.add(handle); vm.add(head);
      vm.rotation.z = 0.4;
      return;
    }
    const colors = { apple: 0xd23b32, stick: 0x9a6a32, coal: 0x2a2a2c, emerald: 0x2ecc71,
      battery: 0xd8c24a, paint_red: 0xc0392b, paint_blue: 0x2f6fd8, paint_green: 0x2ecc71,
      paint_yellow: 0xe6c34a, iron_ingot: 0xd0d3da, bucket: 0x9aa0a8, water_bucket: 0x3a6ff0,
      redstone: 0xc0392b, gold_ingot: 0xe6c34a, steel: 0xc7ccd4, flint: 0x3a3a40,
      flint_and_steel: 0xb0b4bc, book: 0xb5843a,
      diamond: 0x4fe3d8, paper: 0xf2efe4,
      netherite: 0x0a0a0c, key2: 0xb87333, key3: 0xb8c0c8, key4: 0xf2c14e };
    const size = id === "stick" ? [0.06, 0.4, 0.06] : [0.25, 0.25, 0.25];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshLambertMaterial({ color: colors[id] || 0xcccccc }));
    vm.add(mesh);
  }
  Game._setViewmodel = setViewmodel; // (used by the tests)

  // expose the world's per-type geometry through a tiny shim
  function blockGeo(id) { return Game._blockGeo(id); }

  // ===============================================================
  //  Scene setup
  // ===============================================================
  function buildScene(biome) {
    const scene = new THREE.Scene();
    // The Nether is a hazy, fiery red cavern with close fog and warm light.
    if (biome === "nether") {
      const sky = 0x3a0e0a;
      scene.background = new THREE.Color(sky);
      scene.fog = new THREE.Fog(sky, 8, 34);
      scene.add(new THREE.AmbientLight(0xffd2b0, 0.78));
      const glow = new THREE.DirectionalLight(0xff7a3a, 0.5);
      glow.position.set(0.3, 1, 0.2);
      scene.add(glow);
      return scene;
    }
    // The End is a dark, starry void: near-black purple sky, cool light, and a
    // pale island glowing softly in the gloom.
    if (biome === "end") {
      const sky = 0x0c0a1a;
      scene.background = new THREE.Color(sky);
      scene.fog = new THREE.Fog(sky, 14, 48);
      scene.add(new THREE.AmbientLight(0xd8ccff, 0.7));
      const glow = new THREE.DirectionalLight(0xa07adf, 0.42);
      glow.position.set(0.2, 1, 0.3);
      scene.add(glow);
      return scene;
    }
    const sky = biome === "desert" ? 0xbfe0ef : 0x87ceeb;
    scene.background = new THREE.Color(sky);
    scene.fog = new THREE.Fog(sky, 22, 58);

    const ambient = new THREE.AmbientLight(0xffffff, 0.72);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(0.6, 1, 0.4);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(-0.5, 0.6, -0.4);
    scene.add(fill);
    // Remember what the surface looks like by day so the day/night cycle can
    // dim it down toward night and back.
    scene.userData.dayNight = { ambient: ambient, sun: sun, fill: fill, daySky: sky,
      baseAmbient: 0.72, baseSun: 0.85, baseFill: 0.25 };
    return scene;
  }

  function buildHighlight(scene) {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.005, 1.005, 1.005));
    const mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5 });
    const box = new THREE.LineSegments(geo, mat);
    box.visible = false;
    scene.add(box);
    return box;
  }

  // Outlines the block under the crosshair. The outline is tinted so ripe food
  // (apples, watermelons) and plants stand out — but nothing is written on the
  // screen, so the view stays clean.
  function updateTargeting() {
    const hit = S.world.raycast(S.player.eyePosition(), S.player.lookDir());
    if (!hit) { S.highlight.visible = false; return; }

    S.highlight.visible = true;
    S.highlight.position.set(hit.block.x + 0.5, hit.block.y + 0.5, hit.block.z + 0.5);

    const id = S.world.get(hit.block.x, hit.block.y, hit.block.z);
    let color = 0x000000, opacity = 0.5;
    if (id === "apple" || id === "watermelon") { color = 0xffd23b; opacity = 0.95; }
    else if (Game.harvestOnTap(id)) { color = 0x9be36a; opacity = 0.85; }
    S.highlight.material.color.setHex(color);
    S.highlight.material.opacity = opacity;
  }

  // ===============================================================
  //  Vitals UI
  // ===============================================================
  function renderVitals() {
    drawPips($("health-row"), S.player.hp, C.MAX_HP, "hp");
    drawPips($("food-row"), S.player.food, C.MAX_FOOD, "food");
  }

  // Darken the screen while the wither effect is draining the player, easing the
  // tint away over the effect's final second so it fades out cleanly.
  function updateWitherTint() {
    const ov = $("wither-overlay");
    if (!ov) return;
    const w = S.player.wither || 0;
    if (w > 0) {
      ov.classList.add("on");
      ov.style.opacity = String(Math.min(1, w)); // fade out over the last second
    } else if (ov.classList.contains("on")) {
      ov.classList.remove("on");
      ov.style.opacity = "";
    }
  }

  // Draw a vitals bar as a row of little blocky squares (each square = 2 points),
  // filled ones lit in the bar's colour and the rest a dark empty cell.
  function drawPips(row, value, max, cls) {
    const cells = max / 2;        // each square = 2 points
    const filled = Math.round(value / 2);
    let html = "";
    for (let i = 0; i < cells; i++) {
      html += '<span class="vcell ' + cls + (i < filled ? " on" : "") + '"></span>';
    }
    row.innerHTML = html;
  }

  // ===============================================================
  //  Main loop
  // ===============================================================
  // ===============================================================
  //  Day / night cycle
  // ===============================================================
  // How "night" it is right now, 0 (full day) .. 1 (full night), with a short
  // dusk/dawn fade at each edge of the 2-minute night.
  function nightFactor(clock) {
    const t = ((clock % CYCLE_LEN) + CYCLE_LEN) % CYCLE_LEN;
    if (t < DAY_LEN - DUSK) return 0;                          // broad daylight
    if (t < DAY_LEN) return (t - (DAY_LEN - DUSK)) / DUSK;     // dusk: 0 -> 1
    if (t < CYCLE_LEN - DUSK) return 1;                        // deep night
    return 1 - (t - (CYCLE_LEN - DUSK)) / DUSK;               // dawn: 1 -> 0
  }
  function isNightNow() { return nightFactor(S.worldClock) > 0.5; }
  Game.isNight = isNightNow; // (used by tests / other systems)

  const NIGHT_SKY = new THREE.Color(0x0a1226);
  const _dnDay = new THREE.Color(), _dnCol = new THREE.Color();
  function updateDayNight(dt) {
    S.worldClock += dt;
    if (S.inNether || S.inEnd) return;            // the Nether & End keep their own mood
    const dn = S.scene && S.scene.userData && S.scene.userData.dayNight;
    if (!dn) return;
    const n = nightFactor(S.worldClock);
    _dnDay.setHex(dn.daySky);
    _dnCol.copy(_dnDay).lerp(NIGHT_SKY, n);
    if (S.scene.background && S.scene.background.copy) S.scene.background.copy(_dnCol);
    if (S.scene.fog) S.scene.fog.color.copy(_dnCol);
    dn.ambient.intensity = dn.baseAmbient * (1 - 0.60 * n);
    dn.sun.intensity = dn.baseSun * (1 - 0.72 * n);
    dn.fill.intensity = dn.baseFill * (1 - 0.50 * n);
  }

  // Is the player wearing any armour or holding a shield right now? Only EQUIPPED
  // gear counts — carrying it in the backpack isn't enough. (Blocks arrows.)
  function hasDefense() {
    return Game.EQUIP_SLOTS.some((slot) => !!S.equip[slot]);
  }
  Game.hasDefense = hasDefense; // world.js uses this when an arrow lands

  function loop(now) {
    if (!S.running) return;
    requestAnimationFrame(loop);
    let dt = (now - S.last) / 1000;
    S.last = now;
    if (dt > 0.1) dt = 0.1; // avoid huge jumps after a pause

    if (!S.paused && !S.player.dead) {
      if (S.riding) updateRiding(dt);
      else S.player.update(dt, S.input);
      S.world.updateAnimals(dt);
      updateDayNight(dt);
      if (S.inNether) S.world.updateNether(dt, S.player);
      else if (S.inEnd) S.world.updateEnd(dt, S.player); // the dragon breathes purple fire
      else S.world.updateNight(dt, S.player, isNightNow()); // surface skeletons at night
      handlePortal(dt);
      updateTargeting();
      renderVitals();
      updateWitherTint();

      // hand swing / bob
      if (S.swing > 0) S.swing = Math.max(0, S.swing - dt);
      const bob = S.input.forward ? Math.sin(now * 0.012) * 0.02 : 0;
      S.viewmodel.position.set(0.55, -0.45 + bob - S.swing, -0.9);

      // autosave every 30s
      S.autosaveTimer += dt;
      if (S.autosaveTimer > 30) { S.autosaveTimer = 0; saveGame(true); }

      // Count only real play time toward the next break; trigger at 17 min.
      S.playClock += dt;
      if (S.playClock >= BREAK_EVERY) startBreak();

      if (S.player.dead) onDeath();
    }

    // The break countdown keeps ticking while the game is paused.
    if (S.onBreak) tickBreak(dt);

    S.renderer.render(S.scene, S.camera);
  }

  // ===============================================================
  //  Take-a-break reminder
  // ===============================================================
  const nowMs = () => Date.now();

  function startBreak() {
    S.playClock = 0;
    S.breakEndsAt = nowMs() + BREAK_LENGTH * 1000; // a fixed real-world end time
    showBreakOverlay();
    saveGame(true);                 // persist the break so a reload can't skip it
  }

  // Show (or re-show) the break panel and reset the countdown UI. Used both when
  // a break first starts and when one is resumed after a page reload.
  function showBreakOverlay() {
    S.onBreak = true;
    S.breakLeft = Math.max(0, (S.breakEndsAt - nowMs()) / 1000);
    updateBreakBar();
    // Keep the Resume button hidden AND disabled until the timer truly runs
    // out, so the break can't be skipped early (or by reloading the page).
    $("btn-resume-break").classList.add("hidden");
    $("btn-resume-break").disabled = true;
    showPanel("break-panel");       // also sets S.paused = true
  }

  function tickBreak(dt) {
    // Count down against the real clock so reloading or waiting can't shorten
    // (or skip) the break. Fall back to dt only if no end time is set.
    if (S.breakEndsAt) S.breakLeft = Math.max(0, (S.breakEndsAt - nowMs()) / 1000);
    else S.breakLeft = Math.max(0, S.breakLeft - dt);
    updateBreakBar();
    if (S.breakLeft <= 0) {
      // Break's over — reveal the Resume button (we don't auto-resume so the
      // world stays safely paused if the player is still away).
      $("break-time").textContent = "All done! 🎉";
      $("btn-resume-break").classList.remove("hidden");
      $("btn-resume-break").disabled = false;
    }
  }

  function updateBreakBar() {
    const frac = Math.max(0, S.breakLeft / BREAK_LENGTH);
    $("break-bar-fill").style.width = (frac * 100) + "%";
    const secs = Math.ceil(S.breakLeft);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    $("break-time").textContent = m + ":" + String(s).padStart(2, "0");
  }

  function endBreak() {
    // Safety net: never resume while the countdown is still running.
    if (S.onBreak && S.breakLeft > 0) return;
    S.onBreak = false;
    S.breakLeft = 0;
    S.breakEndsAt = 0;              // clear it so a later reload won't re-trigger
    S.playClock = 0;
    saveGame(true);                 // persist that the break is finished
    hideAllPanels();                // unpauses the game
    toast("Welcome back! 🎮");
  }

  function onDeath() {
    // The Totem of Undying — the woodland mansion's special treasure. If you'd
    // die while carrying it, it blazes up, brings you back on the spot with
    // full health, and crumbles to dust. One life per totem.
    if (countItem("totem") > 0) {
      removeItems({ totem: 1 });
      S.player.dead = false;
      S.player.hp = C.MAX_HP;
      S.player.food = Math.max(S.player.food, 10);
      S.player.wither = 0;
      S.player.fallPeak = S.player.pos.y;   // no follow-up fall damage
      updateWitherTint();
      renderHotbar(); updateHand();
      toast("🗿 The Totem of Undying blazes golden — it saves your life and crumbles to dust!");
      return;
    }
    S.riding = null;
    S.paused = true;
    S.player.wither = 0;            // clear any lingering wither so the tint lifts
    updateWitherTint();
    $("death-reason").textContent = "You " + (S.player.lastDamage || "ran out of health") + ".";
    document.body.classList.add("menu-open");
    showPanel("death-panel");
  }

  // ===============================================================
  //  Starting / loading a world
  // ===============================================================
  function startWorld(world, restore) {
    // Tear down any previous scene.
    if (S.scene) {
      S.renderer.renderLists && S.renderer.renderLists.dispose();
    }
    S.world = world;
    S.scene = buildScene(world.biome);

    world.scene = S.scene;
    world.material = world.material || new THREE.MeshLambertMaterial({ vertexColors: true });
    world.buildMeshes();
    world.animals.forEach((a) => S.scene.add(a)); // attach the wandering animals

    if (!S.camera) {
      S.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    }
    if (S.viewmodel && S.viewmodel.parent) S.viewmodel.parent.remove(S.viewmodel);
    if (S.offhand && S.offhand.parent) S.offhand.parent.remove(S.offhand);
    S.scene.add(S.camera);

    // viewmodel attaches to the camera (your right hand)
    S.viewmodel = new THREE.Group();
    S.viewmodel.position.set(0.55, -0.45, -0.9);
    S.camera.add(S.viewmodel);

    // offhand attaches to the camera too (your left hand) — holds a shield when
    // one is equipped so you can see you're protected.
    S.offhand = new THREE.Group();
    S.offhand.position.set(-0.62, -0.42, -0.9);
    S.offhand.rotation.set(0, 0.35, 0.08);
    S.camera.add(S.offhand);

    S.highlight = buildHighlight(S.scene);
    world._scene = S.scene;          // cache so we can swap back from the Nether
    world._highlight = S.highlight;
    S.player = new Game.Player(S.camera, world);

    if (restore) {
      const p = restore.player;
      S.player.pos.set(p.x, p.y, p.z);
      S.player.yaw = p.yaw; S.player.pitch = p.pitch;
      S.player.hp = p.hp; S.player.food = p.food;
      S.player.fallPeak = p.y;
      S.player.syncCamera();
      S.inv = restore.inventory;
      S.selected = restore.selected || 0;
      S.chests = restore.chests || {};
      S.questKeysGiven = restore.questKeysGiven || {};
      S.equip = Object.assign(emptyEquip(), restore.equip || {});
    } else {
      S.inv = new Array(36).fill(null);
      S.selected = 0;
      S.chests = {};
      S.questKeysGiven = {};
      S.equip = emptyEquip();
    }
    // The mansion's chests come stocked with treasure, and the first
    // settlement's starter chest with a welcome kit (both skipped for any
    // chest the player already opened — their contents live in the save).
    prefillMansionChests(world);
    prefillStarterChest(world);

    // A fresh world starts with NO save slot — nothing saves until the player
    // presses Save and picks one. (loadGame re-binds the slot right after.)
    S.saveSlot = null;

    S.riding = null;
    S.playClock = (restore && restore.playClock) || 0;
    S.onBreak = false;
    S.breakLeft = 0;
    // A break in progress is remembered by its wall-clock end time, so reloading
    // the page can't skip it.
    S.breakEndsAt = (restore && restore.breakEndsAt) || 0;
    S.worldClock = (restore && restore.worldClock) || 0; // start a fresh world at dawn

    // Dimension bookkeeping: this fresh world is the overworld; the Nether and
    // the End are built lazily the first time you step through their portals.
    S.overworld = world;
    S.netherWorld = null;
    S.inNether = false;
    S.endWorld = null;
    S.inEnd = false;
    S.won = false;
    S.creditsEnding = false;
    S.portalCooldown = 0;
    S.portalLinks = [];
    S.questPortalExit = world.questPortalExit || null;

    renderHotbar();
    updateHand();
    renderVitals();
    setViewmodel(selectedSlot() ? selectedSlot().id : null);
    updateOffhand();                     // show an already-equipped shield on load
    onResize(); // make sure the canvas matches the current screen/orientation

    S.paused = false;
    document.body.classList.remove("menu-open");
    hideAllPanels();

    if (!S.running) {
      S.running = true;
      S.last = performance.now();
      requestAnimationFrame(loop);
    }
    if (!restore) toast("Punch a tree to get wood! 🌳");

    // Reloaded mid-break? If the break's real end time is still in the future,
    // put the break overlay straight back up (paused) so it can't be dodged. If
    // it already elapsed while away, the break is done — clear it and play on.
    if (S.breakEndsAt) {
      if (nowMs() < S.breakEndsAt) showBreakOverlay();
      else { S.breakEndsAt = 0; if (restore) toast("Thanks for taking a break! 🎮"); }
    }
  }

  // A genuinely random 32-bit number (crypto-backed when available, so the
  // "Surprise me" button is truly random rather than a predictable pattern).
  function randomSeed() {
    if (window.crypto && window.crypto.getRandomValues) {
      return window.crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
    }
    return (Math.random() * 0xffffffff) >>> 0;
  }

  function newWorld(biome) {
    // "Surprise me" rolls a fresh biome AND a fresh seed every single time.
    if (biome === "random") biome = (randomSeed() & 1) ? "forest" : "desert";
    const seed = randomSeed();
    // Fresh worlds are always full-size (a legacy save may have shrunk C.WORLD).
    Game.CONST.WORLD = DEFAULT_WORLD_SIZE;
    const world = new Game.World(null, seed, biome);
    world.generate();
    startWorld(world, null);
  }

  // The Classic map: a brand-new world on the original cosy 40x40 layout —
  // one biome throughout, sky-high settlement spires on the centre axes, and
  // the original key quest (the gold key opens the fourth house's lit portal).
  function newLegacyWorld() {
    const biome = (randomSeed() & 1) ? "forest" : "desert";
    const seed = randomSeed();
    Game.CONST.WORLD = 40;
    const world = new Game.World(null, seed, biome, true);
    world.generate();
    startWorld(world, null);
  }

  // ===============================================================
  //  Saving / loading (localStorage) — three slots
  // ===============================================================
  // Nothing saves (not even the autosave) until the player presses Save and
  // picks a slot. From then on that slot is "theirs": the 30-second autosave,
  // the Menu button and pagehide all quietly keep it up to date.
  function saveGame(quiet) {
    // The End is never saved — win your way out, don't camp there. (This covers
    // the manual Save button, the 30s autosave, the Menu button and pagehide.)
    if (S.inEnd) { if (!quiet) toast("The End can't be saved — craft the Exit Portal to finish! ✨"); return; }
    // No slot chosen yet: a manual save asks for one; automatic saves wait.
    if (!S.saveSlot) { if (!quiet) openSlotPicker(); return; }
    const ow = S.overworld;
    if (!ow || !S.player) return;
    const changes = [];
    ow.changes.forEach((id, key) => {
      const p = key.split(",");
      changes.push({ x: +p[0], y: +p[1], z: +p[2], id: id });
    });
    // If you're saving while in the Nether, store the safe overworld cell you'd
    // return to, so loading never drops you into the (regenerated) Nether.
    const pos = S.inNether ? (S.questPortalExit || ow.spawn) : S.player.pos;
    const data = {
      version: 3,        // v3: big multi-biome worlds (v2: the brick-item split)
      worldSize: Game.CONST.WORLD,
      legacy: !!ow.legacy, // an old 40-block world stays its old self forever
      seed: ow.seed,
      biome: ow.biome,
      changes: changes,
      player: {
        x: pos.x, y: pos.y, z: pos.z,
        yaw: S.player.yaw, pitch: S.player.pitch,
        hp: S.player.hp, food: S.player.food
      },
      inventory: S.inv,
      equip: S.equip,
      selected: S.selected,
      chests: S.chests,
      questKeysGiven: S.questKeysGiven,
      worldClock: S.worldClock,
      playClock: S.playClock,
      breakEndsAt: S.breakEndsAt
    };
    try {
      localStorage.setItem(SLOT_KEYS[S.saveSlot - 1], JSON.stringify(data));
      if (!quiet) toast("Game saved to slot " + S.saveSlot + "! 💾");
    } catch (e) {
      if (!quiet) toast("Could not save (storage full?)");
    }
  }

  function hasSave(slot) {
    try { return !!localStorage.getItem(SLOT_KEYS[slot - 1]); } catch (e) { return false; }
  }

  // A quick peek at what a slot holds, for labelling its buttons.
  function slotMeta(slot) {
    let data;
    try { data = JSON.parse(localStorage.getItem(SLOT_KEYS[slot - 1])); } catch (e) { return null; }
    if (!data) return null;
    return { biome: data.biome, legacy: (data.version || 0) < 3 || !!data.legacy };
  }

  function slotLabel(slot) {
    const m = slotMeta(slot);
    if (!m) return "Slot " + slot + " — empty";
    const b = m.biome === "desert" ? "🏜️ Desert" : "🌳 Forest";
    return "Slot " + slot + " — " + b + (m.legacy ? " (classic 40×40)" : "");
  }

  // The in-game picker shown the first time Save is pressed (or via the Save
  // button before a slot is bound). Choosing a slot saves there right away and
  // makes it the automatic slot from then on.
  function openSlotPicker() {
    for (let n = 1; n <= 3; n++) $("btn-slot-" + n).textContent = "💾 " + slotLabel(n);
    showPanel("slot-panel");
  }

  function pickSaveSlot(n) {
    S.saveSlot = n;
    hideAllPanels();
    saveGame(false);
  }

  // The old single-save key becomes slot 1, once, so nobody loses a world.
  function migrateOldSave() {
    try {
      const old = localStorage.getItem(OLD_SAVE_KEY);
      if (old && !localStorage.getItem(SLOT_KEYS[0])) localStorage.setItem(SLOT_KEYS[0], old);
      if (old) localStorage.removeItem(OLD_SAVE_KEY);
    } catch (e) {}
  }

  // ---- Settings (a small, separate, global preference store) ------
  function loadSettings() {
    let data;
    try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch (e) { data = null; }
    // Default to inverted look; only turn it off if the player explicitly did.
    if (data && typeof data.invertLook === "boolean") S.invertLook = data.invertLook;
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ invertLook: S.invertLook })); } catch (e) {}
  }

  // Pre-v2 saves used "brick"/"brown_brick"/"red_brick" for the masonry *block*.
  // Those ids are now single-brick *items*; the blocks are the plural "bricks".
  // Remap any placed blocks and stored stacks so old brick builds survive intact.
  const BRICK_BLOCK_MIGRATION = { brick: "bricks", brown_brick: "brown_bricks", red_brick: "red_bricks" };
  function migrateBrickBlocks(data) {
    const remap = (id) => BRICK_BLOCK_MIGRATION[id] || id;
    (data.changes || []).forEach((c) => { if (c) c.id = remap(c.id); });
    (data.inventory || []).forEach((s) => { if (s) s.id = remap(s.id); });
    Object.keys(data.chests || {}).forEach((k) => {
      (data.chests[k] || []).forEach((s) => { if (s) s.id = remap(s.id); });
    });
  }

  function loadGame(slot) {
    let data;
    try { data = JSON.parse(localStorage.getItem(SLOT_KEYS[slot - 1])); } catch (e) { return false; }
    if (!data) return false;
    if (!data.version) migrateBrickBlocks(data);   // upgrade legacy brick ids
    // Worlds saved before the multi-biome update were 40 blocks wide with one
    // biome throughout. They regenerate exactly as they were: same size, same
    // generator — so nothing the player built or explored moves.
    const legacy = (data.version || 0) < 3 || !!data.legacy;
    Game.CONST.WORLD = data.worldSize || (legacy ? 40 : DEFAULT_WORLD_SIZE);
    const world = new Game.World(null, data.seed, data.biome, legacy);
    world.generate();
    if (data.changes) world.applyChanges(data.changes);
    // make sure the inventory array is the right length
    const inv = new Array(36).fill(null);
    (data.inventory || []).forEach((s, i) => { if (s && i < 36) inv[i] = s; });
    startWorld(world, { player: data.player, inventory: inv, selected: data.selected,
      chests: data.chests || {}, questKeysGiven: data.questKeysGiven || {},
      equip: data.equip || {},
      worldClock: data.worldClock || 0, playClock: data.playClock || 0,
      breakEndsAt: data.breakEndsAt || 0 });
    // Continuing a slot binds it: autosaves keep flowing into the same slot.
    S.saveSlot = slot;
    return true;
  }

  // ===============================================================
  //  Panels
  // ===============================================================
  function showPanel(id) {
    $(id).classList.remove("hidden");
    if (id !== "death-panel") document.body.classList.add("menu-open");
    if (S.running) S.paused = true;
  }
  function hideAllPanels() {
    returnGrid();    // never swallow ingredients left in the crafting grid
    returnFurnace(); // ...or anything sitting in the furnace
    S.openChestKey = null;
    S.tradingWith = null;
    document.querySelectorAll(".panel-overlay").forEach((p) => p.classList.add("hidden"));
    document.body.classList.remove("menu-open");
    if (S.running && !(S.player && S.player.dead)) S.paused = false;
  }

  // ===============================================================
  //  Controls wiring
  // ===============================================================
  function holdButton(el, key) {
    const down = (e) => { e.preventDefault(); S.input[key] = true; };
    const up = (e) => { if (e) e.preventDefault(); S.input[key] = false; };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointerleave", up);
    el.addEventListener("pointercancel", up);
  }

  function tapButton(el, fn) {
    el.addEventListener("click", (e) => { e.preventDefault(); fn(); });
  }

  function wireControls() {
    holdButton($("btn-forward"), "forward");
    holdButton($("btn-jump"), "jump");

    tapButton($("btn-place"), doUse);
    tapButton($("btn-mine"), doHit);
    tapButton($("btn-eat"), eatFood);

    // Top buttons
    tapButton($("btn-inventory"), () => { renderInventory(); showPanel("inventory-panel"); });
    tapButton($("btn-craft"), () => openCrafting(false)); // Craft button = 2x2 grid
    tapButton($("craft-result"), doCraft);
    tapButton($("tab-craft"), () => { CR.tab = "craft"; renderRecipeBook(); });
    tapButton($("tab-furnace"), () => { CR.tab = "furnace"; renderRecipeBook(); });

    // Furnace panel
    tapButton($("furnace-fuel"), () => furnaceFill("fuel"));
    tapButton($("furnace-input"), () => furnaceFill("input"));
    tapButton($("furnace-smelt"), doSmelt);
    tapButton($("btn-save"), () => saveGame(false));
    tapButton($("btn-menu"), () => { saveGame(true); refreshStartPanel(); showPanel("start-panel"); });

    tapButton($("btn-resume-break"), endBreak);

    // Every panel's Close button just hides the panels — except the credits'
    // Close during the winning finale, which drops back to the Home Screen.
    document.querySelectorAll(".close-btn:not(.credits-close)").forEach((b) => b.addEventListener("click", hideAllPanels));
    const creditsClose = document.querySelector(".credits-close");
    if (creditsClose) creditsClose.addEventListener("click", () => {
      if (S.creditsEnding) returnToHome(); else hideAllPanels();
    });

    // Start panel buttons
    tapButton($("btn-new-forest"), () => newWorld("forest"));
    tapButton($("btn-new-desert"), () => newWorld("desert"));
    tapButton($("btn-new-random"), () => newWorld("random"));
    tapButton($("btn-new-legacy"), () => newLegacyWorld());
    // Three continue buttons on the title screen, one per save slot.
    [1, 2, 3].forEach((n) => {
      tapButton($("btn-load-" + n), () => { if (!loadGame(n)) toast("That slot is empty."); });
      tapButton($("btn-slot-" + n), () => pickSaveSlot(n));
    });
    tapButton($("btn-slot-cancel"), () => hideAllPanels());
    tapButton($("btn-invert-look"), () => {
      S.invertLook = !S.invertLook;
      saveSettings();
      refreshSettings();
    });
    tapButton($("btn-respawn"), () => {
      S.player.respawn();
      hideAllPanels();
      S.paused = false;
      document.body.classList.remove("menu-open");
    });

    // Suppress the iOS/Android long-press context menu, selection loupe and the
    // blue selection box so a press-and-hold on the world never pops one up.
    window.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("selectstart", (e) => e.preventDefault());
    document.addEventListener("dragstart", (e) => e.preventDefault());
    // iOS double-tap / long-press zoom gestures.
    document.addEventListener("gesturestart", (e) => e.preventDefault());

    // iPhone Safari (iOS 15+) still shows the long-press selection box / loupe
    // even with `user-select:none` — the only reliable fix is to preventDefault
    // the underlying TOUCH events on the world. We do this only on #game (the
    // 3D view), so menus/panels keep scrolling and the buttons still work.
    const gameEl = $("game");
    const stopTouch = (e) => { if (e.cancelable) e.preventDefault(); };
    gameEl.addEventListener("touchstart", stopTouch, { passive: false });
    gameEl.addEventListener("touchmove", stopTouch, { passive: false });

    wirePointerLook();
    wireKeyboard();
    window.addEventListener("resize", onResize);
    // Some mobile browsers report stale sizes right when orientation flips, so
    // resize again a moment later.
    window.addEventListener("orientationchange", () => { onResize(); setTimeout(onResize, 200); });
    window.addEventListener("pagehide", () => { if (S.running) saveGame(true); });
  }

  // Drag to look around; a quick tap acts on the world.
  function wirePointerLook() {
    const el = $("game");
    let dragging = false, moved = 0, lx = 0, ly = 0;
    el.addEventListener("pointerdown", (e) => {
      // Stop the long-press text-selection / magnifier (the blue "zoom" box).
      e.preventDefault();
      if (S.paused || !S.player) return;
      dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging || !S.player) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      S.player.yaw -= dx * 0.005;
      // Inverted look (the default): dragging DOWN tilts the view UP, and
      // dragging UP tilts it DOWN. Flip the sign when the setting is off.
      const lookSign = S.invertLook ? 1 : -1;
      S.player.pitch = Math.max(-1.45, Math.min(1.45, S.player.pitch + lookSign * dy * 0.005));
    });
    const end = () => {
      if (dragging && moved < 9 && !S.paused) doTap();
      dragging = false;
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", () => { dragging = false; });
  }

  function wireKeyboard() {
    const map = { ArrowUp: "forward", KeyW: "forward", ArrowLeft: "turnLeft", KeyA: "turnLeft",
      ArrowRight: "turnRight", KeyD: "turnRight", Space: "jump" };
    window.addEventListener("keydown", (e) => {
      if (map[e.code]) { S.input[map[e.code]] = true; e.preventDefault(); }
      if (e.code === "KeyE") eatFood();
      if (e.code === "KeyQ") doHit();
      if (e.code === "KeyF") doUse();
      if (e.code >= "Digit1" && e.code <= "Digit9") selectSlot(+e.code.slice(5) - 1);
    });
    window.addEventListener("keyup", (e) => { if (map[e.code]) { S.input[map[e.code]] = false; e.preventDefault(); } });
  }

  // Keep the canvas filling the screen in any orientation. This must resize the
  // renderer even before a world (and camera) exists — otherwise rotating the
  // device on the title screen leaves the canvas at its old size and half the
  // screen shows the page background.
  function onResize() {
    if (S.renderer) S.renderer.setSize(window.innerWidth, window.innerHeight);
    if (S.camera) {
      S.camera.aspect = window.innerWidth / window.innerHeight;
      S.camera.updateProjectionMatrix();
    }
  }

  function refreshStartPanel() {
    for (let n = 1; n <= 3; n++) {
      const btn = $("btn-load-" + n);
      btn.style.display = hasSave(n) ? "block" : "none";
      btn.textContent = "▶️ " + slotLabel(n);
    }
  }

  // Reflect the current settings in the menu (the look-control toggle).
  function refreshSettings() {
    const state = $("invert-look-state");
    const btn = $("btn-invert-look");
    if (!state || !btn) return;
    state.textContent = S.invertLook ? "ON" : "OFF";
    btn.classList.toggle("on", S.invertLook);
  }

  // ===============================================================
  //  Boot
  // ===============================================================
  function boot() {
    S.renderer = new THREE.WebGLRenderer({ antialias: true });
    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    S.renderer.setSize(window.innerWidth, window.innerHeight);
    $("game").appendChild(S.renderer.domElement);

    migrateOldSave();  // the pre-slots save becomes slot 1
    loadSettings();
    wireControls();
    renderHotbar();
    updateHand();
    refreshStartPanel();
    refreshSettings();
    showPanel("start-panel");
  }

  // expose the world geometry builder for the viewmodel before boot
  Game._blockGeo = function (id) { return Game.World ? Game.World.geometry(id) : null; };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

})(window.Game);
