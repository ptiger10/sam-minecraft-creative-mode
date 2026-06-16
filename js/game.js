/* ===========================================================
   game.js — the glue: Three.js scene, inventory, crafting,
   on-screen + keyboard controls, the main loop and saving to
   localStorage.
   =========================================================== */

(function (Game) {
  "use strict";

  const C = Game.CONST;
  const SAVE_KEY = "blocky-world-save-v1";

  // Whole-game state.
  const S = {
    renderer: null,
    camera: null,
    scene: null,
    world: null,
    player: null,
    inv: new Array(36).fill(null),
    selected: 0,
    input: { forward: false, turnLeft: false, turnRight: false, jump: false },
    highlight: null,
    viewmodel: null,
    raycaster: new THREE.Raycaster(),
    running: false,
    paused: false,
    craftTable: false,
    swing: 0,
    last: 0,
    autosaveTimer: 0
  };
  Game.S = S;

  // ---- Small helpers --------------------------------------------
  const $ = (id) => document.getElementById(id);
  const hex = (n) => "#" + (n >>> 0).toString(16).padStart(6, "0");

  function iconHTML(id) {
    const def = Game.itemDef(id);
    if (!def) return "";
    if (def.swatch !== undefined) return '<span class="swatch" style="background:' + hex(def.swatch) + '"></span>';
    return '<span>' + (def.emoji || "?") + "</span>";
  }

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
  function addItem(id, count) {
    let remaining = count;
    // top up existing stacks
    for (let i = 0; i < S.inv.length && remaining > 0; i++) {
      const s = S.inv[i];
      if (s && s.id === id && s.count < Game.MAX_STACK) {
        const add = Math.min(Game.MAX_STACK - s.count, remaining);
        s.count += add; remaining -= add;
      }
    }
    // fill empty slots
    for (let i = 0; i < S.inv.length && remaining > 0; i++) {
      if (!S.inv[i]) {
        const add = Math.min(Game.MAX_STACK, remaining);
        S.inv[i] = { id: id, count: add }; remaining -= add;
      }
    }
    renderHotbar();
    if (!$("inventory-panel").classList.contains("hidden")) renderInventory();
    return count - remaining;
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

  function selectedSlot() { return S.inv[S.selected]; }

  function selectSlot(i) {
    S.selected = i;
    renderHotbar();
    if (!$("inventory-panel").classList.contains("hidden")) renderInventory();
    updateHand();
    setViewmodel(selectedSlot() ? selectedSlot().id : null);
  }

  function buildSlotEl(i) {
    const el = document.createElement("div");
    el.className = "slot" + (i === S.selected ? " selected" : "");
    const s = S.inv[i];
    if (s) {
      el.innerHTML = iconHTML(s.id) + (s.count > 1 ? '<span class="count">' + s.count + "</span>" : "");
      el.title = Game.itemName(s.id);
    }
    el.addEventListener("click", () => selectSlot(i));
    return el;
  }

  function renderHotbar() {
    const bar = $("hotbar");
    bar.innerHTML = "";
    for (let i = 0; i < 9; i++) bar.appendChild(buildSlotEl(i));
  }

  function renderInventory() {
    const grid = $("inv-grid");
    grid.innerHTML = "";
    for (let i = 0; i < S.inv.length; i++) grid.appendChild(buildSlotEl(i));
  }

  function updateHand() {
    const s = selectedSlot();
    if (s) {
      $("hand-icon").innerHTML = iconHTML(s.id);
      $("hand-name").textContent = Game.itemName(s.id) + (s.count > 1 ? " x" + s.count : "");
    } else {
      $("hand-icon").innerHTML = "✊";
      $("hand-name").textContent = "Empty hand";
    }
  }

  // ===============================================================
  //  Crafting — a real shaped grid (2x2 from the Craft button, 3x3 at a table)
  // ===============================================================
  // The grid is filled by tapping an ingredient (the "brush") and then tapping
  // squares; ingredients are pulled from your inventory as you place them and
  // returned if you take them back out or close the panel. The result square
  // shows what the current arrangement makes; tap it to craft.
  const CR = { size: 2, grid: [], brush: null };
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

    // The recipe book (tap to auto-arrange).
    const book = $("recipe-book");
    book.innerHTML = "";
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
    const s = selectedSlot();
    const hit = S.world.raycast(S.player.eyePosition(), S.player.lookDir());

    // Holding a placeable block -> build.
    if (s && Game.itemDef(s.id) && Game.itemDef(s.id).placeable) {
      if (!hit) { toast("Aim at a block to build on."); return; }
      const c = hit.place;
      if (S.world.occupied(c.x, c.y, c.z)) return;
      if (placeOverlapsPlayer(c.x, c.y, c.z)) { toast("No room to place that here."); return; }
      S.world.setBlock(c.x, c.y, c.z, s.id);
      s.count -= 1;
      if (s.count <= 0) S.inv[S.selected] = null;
      renderHotbar(); updateHand();
      setViewmodel(selectedSlot() ? selectedSlot().id : null);
      S.swing = 0.18;
      return;
    }

    // Not holding a block: tapping a crafting table opens it.
    if (hit && S.world.get(hit.block.x, hit.block.y, hit.block.z) === "crafting_table") {
      openCrafting(true);
      return;
    }
    toast("Pick a block from your hotbar to build.");
  }

  function doHit() {
    const hit = S.world.raycast(S.player.eyePosition(), S.player.lookDir());
    let blockDist = null;
    if (hit) {
      const center = new THREE.Vector3(hit.block.x + 0.5, hit.block.y + 0.5, hit.block.z + 0.5);
      blockDist = S.player.eyePosition().distanceTo(center);
    }

    // Animals come first if they're closer — and they can't be hurt.
    const animal = aimedAnimal(blockDist);
    if (animal) {
      animal.userData.hop = 0.5;
      animal.userData.dir = Math.random() * Math.PI * 2;
      toast("You can't hurt the animals! 🐷");
      S.swing = 0.18;
      return;
    }

    if (!hit) return;
    const id = S.world.get(hit.block.x, hit.block.y, hit.block.z);
    const def = Game.BlockDefs[id];
    if (!def) return;
    S.swing = 0.18;

    const holdingPick = selectedSlot() && Game.isPickaxe(selectedSlot().id);

    // Tapping a crafting table (without a pickaxe) opens it instead of breaking it.
    if (id === "crafting_table" && !holdingPick) { openCrafting(true); return; }

    // Stone & ores need a pickaxe.
    if (def.tool === "pickaxe" && !holdingPick) {
      toast("You need a pickaxe to mine " + def.name + "!");
      return;
    }

    S.world.setBlock(hit.block.x, hit.block.y, hit.block.z, null);
    if (def.drop) {
      addItem(def.drop, 1);
      toast("+1 " + Game.itemName(def.drop));
    }
  }

  // A tap on the world acts on whatever the crosshair is pointing at.
  // Trees, leaves, cactus and apples are *always* grabbed/punched — even with a
  // block in your hand — so holding a block never turns "punch the tree" into an
  // accidental "place". You build by tapping the ground (or with the Place
  // button). Empty hand / pickaxe on anything else digs or mines.
  function doTap() {
    const hit = S.world.raycast(S.player.eyePosition(), S.player.lookDir());
    if (hit && Game.harvestOnTap(S.world.get(hit.block.x, hit.block.y, hit.block.z))) {
      doHit();
      return;
    }
    const s = selectedSlot();
    if (s && Game.itemDef(s.id) && Game.itemDef(s.id).placeable) doUse();
    else doHit();
  }

  // ===============================================================
  //  Viewmodel (the item shown in your hand)
  // ===============================================================
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
    const colors = { apple: 0xd23b32, stick: 0x9a6a32 };
    const size = id === "stick" ? [0.06, 0.4, 0.06] : [0.25, 0.25, 0.25];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshLambertMaterial({ color: colors[id] || 0xcccccc }));
    vm.add(mesh);
  }

  // expose the world's per-type geometry through a tiny shim
  function blockGeo(id) { return Game._blockGeo(id); }

  // ===============================================================
  //  Scene setup
  // ===============================================================
  function buildScene(biome) {
    const scene = new THREE.Scene();
    const sky = biome === "desert" ? 0xbfe0ef : 0x87ceeb;
    scene.background = new THREE.Color(sky);
    scene.fog = new THREE.Fog(sky, 22, 58);

    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(0.6, 1, 0.4);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(-0.5, 0.6, -0.4);
    scene.add(fill);
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
    drawPips($("health-row"), S.player.hp, C.MAX_HP, "❤️", "🖤");
    drawPips($("food-row"), S.player.food, C.MAX_FOOD, "🍗", "🦴");
  }

  function drawPips(row, value, max, full, empty) {
    const pairs = max / 2;        // each icon = 2 points
    const filled = Math.round(value / 2);
    let html = "";
    for (let i = 0; i < pairs; i++) html += '<span class="pip">' + (i < filled ? full : empty) + "</span>";
    row.innerHTML = html;
  }

  // ===============================================================
  //  Main loop
  // ===============================================================
  function loop(now) {
    if (!S.running) return;
    requestAnimationFrame(loop);
    let dt = (now - S.last) / 1000;
    S.last = now;
    if (dt > 0.1) dt = 0.1; // avoid huge jumps after a pause

    if (!S.paused && !S.player.dead) {
      S.player.update(dt, S.input);
      S.world.updateAnimals(dt);
      updateTargeting();
      renderVitals();

      // hand swing / bob
      if (S.swing > 0) S.swing = Math.max(0, S.swing - dt);
      const bob = S.input.forward ? Math.sin(now * 0.012) * 0.02 : 0;
      S.viewmodel.position.set(0.55, -0.45 + bob - S.swing, -0.9);

      // autosave every 30s
      S.autosaveTimer += dt;
      if (S.autosaveTimer > 30) { S.autosaveTimer = 0; saveGame(true); }

      if (S.player.dead) onDeath();
    }

    S.renderer.render(S.scene, S.camera);
  }

  function onDeath() {
    S.paused = true;
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
    S.scene.add(S.camera);

    // viewmodel attaches to the camera
    S.viewmodel = new THREE.Group();
    S.viewmodel.position.set(0.55, -0.45, -0.9);
    S.camera.add(S.viewmodel);

    S.highlight = buildHighlight(S.scene);
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
    } else {
      S.inv = new Array(36).fill(null);
      S.selected = 0;
    }

    renderHotbar();
    updateHand();
    renderVitals();
    setViewmodel(selectedSlot() ? selectedSlot().id : null);
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
    const world = new Game.World(null, seed, biome);
    world.generate();
    startWorld(world, null);
  }

  // ===============================================================
  //  Saving / loading (localStorage)
  // ===============================================================
  function saveGame(quiet) {
    if (!S.world || !S.player) return;
    const changes = [];
    S.world.changes.forEach((id, key) => {
      const p = key.split(",");
      changes.push({ x: +p[0], y: +p[1], z: +p[2], id: id });
    });
    const data = {
      seed: S.world.seed,
      biome: S.world.biome,
      changes: changes,
      player: {
        x: S.player.pos.x, y: S.player.pos.y, z: S.player.pos.z,
        yaw: S.player.yaw, pitch: S.player.pitch,
        hp: S.player.hp, food: S.player.food
      },
      inventory: S.inv,
      selected: S.selected
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      if (!quiet) toast("Game saved! 💾");
    } catch (e) {
      if (!quiet) toast("Could not save (storage full?)");
    }
  }

  function hasSave() {
    try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
  }

  function loadGame() {
    let data;
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return false; }
    if (!data) return false;
    const world = new Game.World(null, data.seed, data.biome);
    world.generate();
    if (data.changes) world.applyChanges(data.changes);
    // make sure the inventory array is the right length
    const inv = new Array(36).fill(null);
    (data.inventory || []).forEach((s, i) => { if (s && i < 36) inv[i] = s; });
    startWorld(world, { player: data.player, inventory: inv, selected: data.selected });
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
    returnGrid(); // never swallow ingredients left in the crafting grid
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
    tapButton($("btn-save"), () => saveGame(false));
    tapButton($("btn-menu"), () => { saveGame(true); refreshStartPanel(); showPanel("start-panel"); });

    document.querySelectorAll(".close-btn").forEach((b) => b.addEventListener("click", hideAllPanels));

    // Start panel buttons
    tapButton($("btn-new-forest"), () => newWorld("forest"));
    tapButton($("btn-new-desert"), () => newWorld("desert"));
    tapButton($("btn-new-random"), () => newWorld("random"));
    tapButton($("btn-continue"), () => { if (!loadGame()) toast("No saved world found."); });
    tapButton($("btn-respawn"), () => {
      S.player.respawn();
      hideAllPanels();
      S.paused = false;
      document.body.classList.remove("menu-open");
    });

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
      if (S.paused || !S.player) return;
      dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging || !S.player) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      S.player.yaw -= dx * 0.005;
      S.player.pitch = Math.max(-1.45, Math.min(1.45, S.player.pitch - dy * 0.005));
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
    $("btn-continue").style.display = hasSave() ? "block" : "none";
  }

  // ===============================================================
  //  Boot
  // ===============================================================
  function boot() {
    S.renderer = new THREE.WebGLRenderer({ antialias: true });
    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    S.renderer.setSize(window.innerWidth, window.innerHeight);
    $("game").appendChild(S.renderer.domElement);

    wireControls();
    renderHotbar();
    updateHand();
    refreshStartPanel();
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
