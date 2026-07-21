/* ===========================================================
   data.js — constants, blocks, items, recipes, and the
   deterministic random helpers used to build worlds.
   Everything is hung off a single global "Game" object so the
   classic <script> files can share it without modules.
   =========================================================== */

window.Game = window.Game || {};

(function (Game) {
  "use strict";

  // ---- World / player constants ----------------------------------
  Game.CONST = {
    WORLD: 40,        // world is WORLD x WORLD blocks wide/deep
    MAX_Y: 24,        // top of the buildable column
    BASE: 6,          // average surface height
    AMP: 3,           // how bumpy the terrain is
    WATER_LEVEL: 4,   // ponds fill up to this height (kept low so water is rare)
    REACH: 6,         // how many blocks away you can reach
    EYE: 1.62,        // camera height above the player's feet
    P_HALF: 0.3,      // player half-width (collision)
    P_HEIGHT: 1.8,    // player height (collision)
    GRAVITY: 26,      // blocks / s^2
    JUMP_V: 8.4,      // jump velocity
    MOVE_SPEED: 4.3,  // walking speed (blocks / s)
    RIDE_SPEED: 5.2,  // speed while riding an animal (blocks / s)
    CLIMB_SPEED: 3.4, // up/down speed while on a ladder (blocks / s)
    STEP_HEIGHT: 1.0, // how high you auto-step (only onto stairs) without jumping
    SWIM_UP: 4.8,     // how fast jump lifts you toward the surface in water
    SWIM_SINK: 2.0,   // how fast you slowly sink in water
    MAX_AIR: 10,      // seconds of breath before you start drowning
    TURN_SPEED: 1.9,  // turn speed (radians / s)
    FALL_SAFE: 3,     // falls shorter than this do no damage
    MAX_HP: 20,
    MAX_FOOD: 20,
    FOOD_DRAIN: 24    // seconds between losing one food point (slow & forgiving)
  };

  // ---- Tiny seeded PRNG (mulberry32) -----------------------------
  Game.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Deterministic hash -> [0,1) for a set of integers + the world seed.
  Game.hash = function (seed, x, y, z) {
    let h = seed >>> 0;
    h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
    h = Math.imul(h ^ (y | 0), 0x165667b1);
    h = Math.imul(h ^ (z | 0), 0x9e3779b1);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  };

  // Smooth value-noise heightmap (deterministic from the seed).
  Game.makeHeight = function (seed) {
    const corner = (ix, iz) => Game.hash(seed, ix, 777, iz);
    const fade = (t) => t * t * (3 - 2 * t);
    const scale = 7; // size of the hills
    return function (x, z) {
      const sx = x / scale, sz = z / scale;
      const x0 = Math.floor(sx), z0 = Math.floor(sz);
      const tx = fade(sx - x0), tz = fade(sz - z0);
      const c00 = corner(x0, z0), c10 = corner(x0 + 1, z0);
      const c01 = corner(x0, z0 + 1), c11 = corner(x0 + 1, z0 + 1);
      const top = c00 + (c10 - c00) * tx;
      const bot = c01 + (c11 - c01) * tx;
      const n = top + (bot - top) * tz; // 0..1
      return Game.CONST.BASE + Math.round((n - 0.5) * 2 * Game.CONST.AMP);
    };
  };

  // ---- Block definitions -----------------------------------------
  // Each block gets six face colours (vertex-coloured cubes).
  // tool:  "hand" = punchable, "pickaxe" = needs a pickaxe.
  // drop:  item id you receive when you break it (null = nothing).
  // solid: false = you can walk straight through it (water, torch, open doors).
  const B = {
    grass:        { name: "Grass Block", top: 0x6abe46, side: 0x7d6a3f, bottom: 0x73553a, tool: "hand", drop: "grass" },
    dirt:         { name: "Dirt",        all: 0x7d5a36, tool: "hand", drop: "dirt" },
    sand:         { name: "Sand",        all: 0xe3d8a3, tool: "hand", drop: "sand" },
    stone:        { name: "Stone",       all: 0x8a8a8d, tool: "pickaxe", drop: "stone" },
    water:        { name: "Water",       all: 0x2f6fd8, top: 0x4f8ff0, tool: "hand", drop: null, solid: false },
    wood:         { name: "Wood",        top: 0x9c7a48, side: 0x6f5230, bottom: 0x9c7a48, tool: "hand", drop: "wood", harvestOnTap: true },
    planks:       { name: "Wood Planks", all: 0xb18a4f, tool: "hand", drop: "planks" },
    wood_red:     { name: "Red Wood",    all: 0xc0503f, tool: "hand", drop: "wood_red" },
    wood_blue:    { name: "Blue Wood",   all: 0x3f6fc0, tool: "hand", drop: "wood_blue" },
    wood_green:   { name: "Green Wood",  all: 0x4a9a4a, tool: "hand", drop: "wood_green" },
    wood_yellow:  { name: "Yellow Wood", all: 0xd8c24a, tool: "hand", drop: "wood_yellow" },
    leaves:       { name: "Leaves",      all: 0x3f9a3a, tool: "hand", drop: "leaves", harvestOnTap: true },
    cactus:       { name: "Cactus",      all: 0x2f8b46, tool: "hand", drop: "cactus", harvestOnTap: true },
    apple:        { name: "Apple",       all: 0xd23b32, tool: "hand", drop: "apple", harvestOnTap: true },
    watermelon:   { name: "Watermelon", top: 0x7fbf3f, side: 0x8fd14a, bottom: 0x6fae35, tool: "hand", drop: "watermelon", harvestOnTap: true },
    sugarcane:    { name: "Sugar Cane", top: 0xa6d16a, side: 0x86b04a, bottom: 0x6f9a3f, tool: "hand", drop: "sugarcane", harvestOnTap: true, solid: false },
    crafting_table:{ name: "Crafting Table", top: 0xc28a3a, side: 0x7a4a22, bottom: 0xb18a4f, tool: "hand", drop: "crafting_table" },
    furnace:      { name: "Furnace",     top: 0x6b6b70, side: 0x5a5a5e, bottom: 0x4a4a4e, tool: "pickaxe", drop: "furnace" },
    chest:        { name: "Chest",       top: 0xc79a4f, side: 0x8a5a2c, bottom: 0x6f4a26, tool: "hand", drop: "chest" },
    bed:          { name: "Bed",         top: 0xd23b52, side: 0xc0392b, bottom: 0x9c7a48, tool: "hand", drop: "bed" },
    ladder:       { name: "Ladder", top: 0x8a5a2c, side: 0xb8863f, bottom: 0x8a5a2c, tool: "hand", drop: "ladder" },
    stairs:       { name: "Stairs", top: 0xc79a55, side: 0xa57d3e, bottom: 0x8a652f, tool: "hand", drop: "stairs" },
    brick_stairs: { name: "Brick Stairs", top: 0xc24632, side: 0xb33a2c, bottom: 0x8f2e22, tool: "pickaxe", drop: "brick_stairs" },
    fence:        { name: "Fence",  top: 0x8a5a2c, side: 0x6f5230, bottom: 0x6f5230, tool: "hand", drop: "fence" },
    torch:        { name: "Torch",  top: 0xffcc33, side: 0x8a5a2c, bottom: 0x6f5230, tool: "hand", drop: "torch", solid: false },
    glass:        { name: "Glass",  all: 0xbfe3ef, top: 0xd6f0f7, tool: "hand", drop: "glass" },
    window:       { name: "Window", all: 0xbfe3ef, top: 0x8a5a2c, tool: "hand", drop: "window" },
    door:         { name: "Door",   all: 0x8a5a2c, top: 0x7a4a22, tool: "hand", drop: "door" },
    door_window:  { name: "Door (with window)", all: 0x8a5a2c, top: 0x7a4a22, tool: "hand", drop: "door_window" },
    clay:         { name: "Clay",       all: 0xa9a39a, tool: "hand", drop: "clay" },
    brown_clay:   { name: "Brown Clay", all: 0x8a6a4a, tool: "hand", drop: "brown_clay" },
    red_clay:     { name: "Red Clay",   all: 0xb45a3c, tool: "hand", drop: "red_clay" },
    brick:        { name: "Brick",       all: 0xa5503c, tool: "pickaxe", drop: "brick" },
    brown_brick:  { name: "Brown Brick", all: 0x6b4a32, tool: "pickaxe", drop: "brown_brick" },
    red_brick:    { name: "Red Brick",   all: 0xb33a2c, tool: "pickaxe", drop: "red_brick" },
    // Pitch-black obsidian flecked with little purple squares (see obsidianGeometry).
    obsidian:     { name: "Obsidian",    all: 0x0b0b12, top: 0x0b0b12, speckle: 0x7a3fd6, tool: "pickaxe", drop: "obsidian" },
    coal_ore:     { name: "Coal Ore",    all: 0x4a4a4d, base: 0x8a8a8d, tool: "pickaxe", drop: "coal" },
    iron_ore:     { name: "Iron Ore",    all: 0xb9846a, base: 0x8a8a8d, tool: "pickaxe", drop: "iron_ore" },
    gold_ore:     { name: "Gold Ore",    all: 0xe6c34a, base: 0x8a8a8d, tool: "pickaxe", drop: "gold_ore" },
    redstone_ore: { name: "Redstone Ore",all: 0xc0392b, base: 0x8a8a8d, tool: "pickaxe", drop: "redstone_ore" },
    diamond_ore:  { name: "Diamond Ore", all: 0x4fe3d8, base: 0x8a8a8d, tool: "pickaxe", drop: "diamond_ore" },
    emerald_ore:  { name: "Emerald Ore", all: 0x2ecc71, base: 0x8a8a8d, tool: "pickaxe", drop: "emerald_ore" },

    // ---- Quest / road / Nether blocks ----
    // The yellow brick road that links the four settlements together.
    yellow_brick: { name: "Yellow Brick", all: 0xf2cf3b, top: 0xf7dd63, tool: "hand", drop: "yellow_brick" },
    // The Nether: a fiery red underworld you reach through a portal.
    netherrack:   { name: "Netherrack", all: 0x6e2b27, top: 0x7d322d, tool: "hand", drop: "netherrack" },
    netherite_ore:{ name: "Netherite Ore", all: 0x08080a, base: 0x2e2a2c, tool: "pickaxe", drop: "netherite" },
    nether_portal:{ name: "Nether Portal", all: 0x9b3fd6, top: 0xc77bf0, tool: "hand", drop: null, solid: false },
    lava:         { name: "Lava", all: 0xff6a1a, top: 0xffa83a, tool: "pickaxe", drop: null },
    glowstone:    { name: "Glowstone", all: 0xffe08a, top: 0xfff0bd, tool: "hand", drop: "glowstone" },
    // ---- The End: a dark void dimension you reach through the 4th house ----
    // Pale End Stone paves the floating island.
    end_stone:    { name: "End Stone", all: 0xd9d2a0, top: 0xe8e2bb, bottom: 0xc7c08c, tool: "hand", drop: "end_stone" },
    // A glowing crystal that crowns each spire — collect four to craft the exit.
    end_crystal:  { name: "End Crystal", all: 0xd06bff, top: 0xe6a8ff, tool: "hand", drop: "end_crystal", harvestOnTap: true },
    // The dark, starry portal (in the 4th house) that carries you into The End.
    end_portal:   { name: "End Portal", all: 0x0a0a1e, top: 0x2a2a6a, tool: "hand", drop: null, solid: false },
    // The bright crystal portal you craft to leave The End and win the game.
    exit_portal:  { name: "Exit Portal", all: 0xe05cd0, top: 0xff9cf0, tool: "hand", drop: null, solid: false },
    // Fluffy white clouds drifting high in the sky. You can't mine them.
    cloud:        { name: "Cloud", all: 0xf4f8fb, top: 0xffffff, bottom: 0xe6edf4, tool: "hand", drop: null, solid: false },
    // A glowing plaque on the wall of the fourth house: tap it for the credits.
    credits_block:{ name: "Hall of Fame", all: 0x2a2350, top: 0xf2c14e, tool: "hand", drop: null },
    // Locked doors, one per house (2,3,4). Each needs its matching key.
    locked_door_2:{ name: "Locked Door", all: 0x8a5a2c, top: 0x7a4a22, tool: "hand", drop: null, lock: 2 },
    locked_door_3:{ name: "Locked Door", all: 0x8a5a2c, top: 0x7a4a22, tool: "hand", drop: null, lock: 3 },
    locked_door_4:{ name: "Locked Door", all: 0x8a5a2c, top: 0x7a4a22, tool: "hand", drop: null, lock: 4 }
  };

  // Open variants of the doors/window are generated from their closed defs so
  // they share colours but can be walked through (solid:false).
  ["window", "door", "door_window"].forEach((id) => {
    const d = B[id];
    B[id + "_open"] = { name: d.name + " (open)", all: d.all, top: d.top,
      tool: "hand", drop: id, solid: false };
  });

  // Fill in any missing face colours from "all" / "base".
  Object.keys(B).forEach((id) => {
    const d = B[id];
    d.id = id;
    // Ore blocks: mostly stone with a strong tint of the ore colour.
    if (d.base !== undefined) {
      const blend = mix(d.base, d.all, 0.55);
      d.top = d.side = d.bottom = blend;
    }
    if (d.all !== undefined) {
      if (d.top === undefined) d.top = d.all;
      if (d.side === undefined) d.side = d.all;
      if (d.bottom === undefined) d.bottom = d.all;
    }
    if (d.solid === undefined) d.solid = true;
  });

  function mix(a, b, t) {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
  }
  Game.mix = mix;

  Game.BlockDefs = B;
  Game.isBlock = (id) => Object.prototype.hasOwnProperty.call(B, id);
  Game.isSolidBlock = (id) => !!(B[id] && B[id].solid);
  // Blocks you can walk straight up without jumping (auto-step).
  Game.isStairs = (id) => id === "stairs" || id === "brick_stairs";
  // Masonry bricks that render with a running-bond brick pattern.
  Game.BRICK_BLOCKS = ["brick", "red_brick", "brown_brick"];
  Game.isBrickBlock = (id) => Game.BRICK_BLOCKS.indexOf(id) !== -1;
  // "Natural" blocks (trees, leaves, cactus, apples) that a tap always
  // grabs/punches — even when you're holding a block. Intent is read from what
  // you're pointing at, so a block in your hand never turns a "punch the tree"
  // into an accidental "place a block in front of it". You build by tapping the
  // ground / your own structures, or with the Place button.
  Game.harvestOnTap = (id) => !!(B[id] && B[id].harvestOnTap);

  // Touchable blocks that open / close when you tap them.
  Game.OPENABLE = {
    window: "window_open", window_open: "window",
    door: "door_open", door_open: "door",
    door_window: "door_window_open", door_window_open: "door_window"
  };

  // ---- Item definitions (blocks + non-block items) ----------------
  Game.ItemDefs = {};

  // Every block is also an item you can hold and place.
  Object.keys(B).forEach((id) => {
    Game.ItemDefs[id] = {
      name: B[id].name,
      swatch: B[id].top,    // little colour square used as the icon
      swatchSide: B[id].side,
      placeable: true
    };
  });
  // Ore icons carry a speckle so they look like their in-world block.
  Object.keys(B).forEach((id) => {
    if (B[id].base !== undefined) { Game.ItemDefs[id].speckle = B[id].all; Game.ItemDefs[id].ore = true; }
  });
  // Obsidian isn't an ore, but its icon still shows its purple speckles.
  Object.keys(B).forEach((id) => {
    if (B[id].speckle !== undefined && B[id].base === undefined) {
      Game.ItemDefs[id].speckle = B[id].speckle; Game.ItemDefs[id].speckled = true;
    }
  });
  // The open door/window states are never carried around — drop their tidy form.
  ["window_open", "door_open", "door_window_open"].forEach((id) => { Game.ItemDefs[id].hidden = true; });

  // World-only blocks the player never carries or places (portals, locked doors,
  // the credits plaque) are hidden from the inventory and not placeable.
  ["nether_portal", "end_portal", "credits_block", "cloud", "locked_door_2", "locked_door_3", "locked_door_4"].forEach((id) => {
    if (Game.ItemDefs[id]) { Game.ItemDefs[id].hidden = true; Game.ItemDefs[id].placeable = false; }
  });

  // End Crystals are a material you collect and craft with, not a block you place.
  Game.ItemDefs.end_crystal.placeable = false;
  Game.ItemDefs.end_crystal.desc = "A glowing crystal from atop the End's spires. Craft four together into an Exit Portal.";
  Game.ItemDefs.end_stone.desc = "The pale stone of The End. Handy for building.";
  // The crafted Exit Portal: a placeable block you step through to win the game.
  Game.ItemDefs.exit_portal.desc = "Made from four End Crystals. Place it and step through to finish your adventure!";

  // Special non-block items. NOTE: "apple" is also a world block, so this
  // MUST come after the loop above to override it.
  Game.ItemDefs.stick   = { name: "Stick", emoji: "🥢", placeable: false, desc: "A handy stick for tools, ladders and torches." };
  Game.ItemDefs.pickaxe = { name: "Wooden Pickaxe", emoji: "⛏️", placeable: false, tool: true, pick: true, desc: "Mines stone and ores." };
  Game.ItemDefs.stone_pickaxe = { name: "Stone Pickaxe", emoji: "⛏️", placeable: false, tool: true, pick: true, desc: "A sturdier pickaxe." };
  Game.ItemDefs.apple   = { name: "Apple", emoji: "🍎", placeable: false, food: 6, desc: "Eat it to fill your food bar." };
  Game.ItemDefs.coal    = { name: "Coal", emoji: "⚫", placeable: false, fuel: 10, desc: "Burns in a furnace — smelts 10 items. Makes torches too." };
  Game.ItemDefs.battery = { name: "Battery", emoji: "🔋", placeable: false, fuel: 32, desc: "A long-lasting furnace fuel." };
  Game.ItemDefs.emerald = { name: "Emerald", emoji: "💚", placeable: false, desc: "Shiny money. Villagers love these." };
  // Netherite: a rare metal you mine in the Nether and trade for the gold key.
  Game.ItemDefs.netherite = { name: "Netherite", swatch: 0x0a0a0c, swatchSide: 0x050506, placeable: false, desc: "A rare, pitch-black metal. Found in a Nether fortress chest, traded from a piglin, or (rarely) mined. The third villager prizes it." };
  // The three keys, each opening one locked house door.
  Game.ItemDefs.key2 = { name: "Bronze Key", emoji: "🗝️", placeable: false, opens: 2, desc: "Opens the locked door of the second house." };
  Game.ItemDefs.key3 = { name: "Silver Key", emoji: "🗝️", placeable: false, opens: 3, desc: "Opens the locked door of the third house." };
  Game.ItemDefs.key4 = { name: "Gold Key",   emoji: "🗝️", placeable: false, opens: 4, desc: "Opens the locked door of the fourth house." };
  Game.ItemDefs.iron_ingot = { name: "Iron Ingot", emoji: "🔩", placeable: false, desc: "Smelted iron. Craft armour, steel and more." };
  Game.ItemDefs.gold_ingot = { name: "Gold Ingot", swatch: 0xe6c34a, swatchSide: 0xc9a52f, placeable: false, desc: "Smelted from gold ore. Shiny!" };
  Game.ItemDefs.redstone = { name: "Redstone", emoji: "🔴", placeable: false, desc: "Smelted from redstone ore." };
  Game.ItemDefs.diamond = { name: "Diamond", emoji: "💎", placeable: false, desc: "Smelted from diamond ore. Super shiny!" };
  Game.ItemDefs.paper = { name: "Paper", emoji: "📄", placeable: false, desc: "Made from sugar cane at a crafting table. Craft it with wood into a book." };
  Game.ItemDefs.book = { name: "Book", emoji: "📖", placeable: false, desc: "Crafted from paper and wood at a crafting table." };
  Game.ItemDefs.steel = { name: "Steel", swatch: 0xc7ccd4, swatchSide: 0x9aa0a8, placeable: false, desc: "Smelt an iron ingot to get steel. Craft it with flint into flint & steel." };
  Game.ItemDefs.flint = { name: "Flint", swatch: 0x3a3a40, swatchSide: 0x2a2a2e, placeable: false, desc: "Chipped from coal at a crafting table. Craft it with steel into flint & steel." };
  Game.ItemDefs.flint_and_steel = { name: "Flint & Steel", emoji: "🔥", placeable: false, ignites: true, desc: "Tap an obsidian portal frame to light it and open a way to the Nether." };
  Game.ItemDefs.bucket  = { name: "Bucket", emoji: "🪣", placeable: false, desc: "Tap water with it to scoop the water up." };
  Game.ItemDefs.water_bucket = { name: "Water Bucket", emoji: "💧", placeable: true, places: "water", empties: "bucket", desc: "The number shows how many waters it holds. Tap more water to scoop up as much as you like; pour it onto lava to make obsidian, or tap the ground to pour one back out." };
  // You can only get water with a bucket — never carry/place a raw water block.
  Game.ItemDefs.water.placeable = false;
  Game.ItemDefs.water.hidden = true;
  // Lava can't be scooped up or carried — pour water on it to make obsidian.
  Game.ItemDefs.lava.placeable = false;
  Game.ItemDefs.lava.hidden = true;
  Game.ItemDefs.paint_red    = { name: "Red Paint",    swatch: 0xc0392b, placeable: false, paint: "red",    desc: "Paint wood red at a crafting table." };
  Game.ItemDefs.paint_blue   = { name: "Blue Paint",   swatch: 0x2f6fd8, placeable: false, paint: "blue",   desc: "Paint wood blue at a crafting table." };
  Game.ItemDefs.paint_green  = { name: "Green Paint",  swatch: 0x2ecc71, placeable: false, paint: "green",  desc: "Paint wood green at a crafting table." };
  Game.ItemDefs.paint_yellow = { name: "Yellow Paint", swatch: 0xe6c34a, placeable: false, paint: "yellow", desc: "Paint wood yellow at a crafting table." };

  // Watermelon stays a normal placeable block, but you can also eat it.
  Game.ItemDefs.watermelon.food = 8;

  // ---- Armour & shields ------------------------------------------
  // Three tiers (wood / iron / diamond) of helmet, chestplate, leggings, boots
  // and shield. Wearing/holding any of them protects you from a skeleton's
  // arrows. Each is crafted at a table (recipes are added further down).
  Game.ARMOR_MATS = {
    wood:    { label: "Wooden",  mat: "planks",     swatch: 0xb18a4f, side: 0x8a6a34 },
    iron:    { label: "Iron",    mat: "iron_ingot", swatch: 0xd0d3da, side: 0x9aa0a8 },
    diamond: { label: "Diamond", mat: "diamond",    swatch: 0x4fe3d8, side: 0x2bb6ab }
  };
  Game.ARMOR_PIECES = { helmet: "Helmet", chestplate: "Chestplate", leggings: "Leggings", boots: "Boots", shield: "Shield" };
  Object.keys(Game.ARMOR_MATS).forEach((mk) => {
    const m = Game.ARMOR_MATS[mk];
    Object.keys(Game.ARMOR_PIECES).forEach((pk) => {
      const id = mk + "_" + pk;
      const isShield = pk === "shield";
      Game.ItemDefs[id] = {
        name: m.label + " " + Game.ARMOR_PIECES[pk],
        swatch: m.swatch, swatchSide: m.side, placeable: false,
        armor: !isShield, shield: isShield,
        equip: true, slot: pk,              // which equipment slot it goes in
        desc: isShield
          ? "Tap it in your backpack to hold the shield — it blocks a skeleton's arrows."
          : "Tap it in your backpack to wear it — armour blocks a skeleton's arrows."
      };
    });
  });
  // The five equipment slots, in the order they're shown.
  Game.EQUIP_SLOTS = ["helmet", "chestplate", "leggings", "boots", "shield"];
  // Anything that counts as protection against arrows.
  Game.isShield = (id) => !!(Game.ItemDefs[id] && Game.ItemDefs[id].shield);
  Game.isArmor = (id) => !!(Game.ItemDefs[id] && Game.ItemDefs[id].armor);
  Game.isDefense = (id) => Game.isShield(id) || Game.isArmor(id);

  // A few descriptions for placeable blocks (shown in the inventory title).
  const DESCS = {
    furnace: "Place it and tap to smelt sand, clay, ore and iron ingots.",
    chest: "Place it and tap to store lots of items.",
    crafting_table: "Place it and tap for the full 3×3 crafting grid.",
    stairs: "Walk straight up or down them to change height — no jumping needed.",
    bed: "A cosy place to sleep.",
    fence: "Pen animals in — they won't cross a fence.",
    torch: "A little light for dark places.",
    glass: "See-through block. Build windows with it.",
    window: "Tap it to open and close the window.",
    door: "Tap it to open and close the door.",
    door_window: "A door with a window built in. Tap to open.",
    obsidian: "The hardest, pitch-black block, flecked with purple. Make it by pouring water on lava.",
    emerald_ore: "Smelt it in a furnace to get an emerald.",
    gold_ore: "Smelt it in a furnace to get a gold ingot.",
    redstone_ore: "Smelt it in a furnace to get redstone.",
    diamond_ore: "Smelt it in a furnace to get a diamond.",
    sugarcane: "Craft three into paper at a crafting table."
  };
  Object.keys(DESCS).forEach((id) => { if (Game.ItemDefs[id]) Game.ItemDefs[id].desc = DESCS[id]; });

  // Any pickaxe can mine stone & ores.
  Game.isPickaxe = (id) => id === "pickaxe" || id === "stone_pickaxe";

  Game.itemName = (id) => (Game.ItemDefs[id] ? Game.ItemDefs[id].name : id);
  Game.itemDef = (id) => Game.ItemDefs[id];
  Game.MAX_STACK = 99;

  // ---- Crafting recipes (shaped, like Minecraft) -----------------
  const W = "wood", S = "stick", T = "stone", G = "glass", PL = "planks",
        CO = "coal", IR = "iron_ore", RS = "redstone_ore";
  Game.Recipes = [
    // 1 wood -> 4 planks.
    { id: "planks", gives: { id: "planks", count: 4 }, pattern: [[W]] },
    // 2 wood stacked vertically -> 1 stick.
    { id: "stick", gives: { id: "stick", count: 1 }, pattern: [[W], [W]] },
    // 4 wood in a square -> a crafting table.
    { id: "crafting_table", gives: { id: "crafting_table", count: 1 }, pattern: [[W, W], [W, W]] },
    // 4 stone in a square -> a furnace.
    { id: "furnace", gives: { id: "furnace", count: 1 }, pattern: [[T, T], [T, T]] },
    // Coal on top of a stick -> 4 torches.
    { id: "torch", gives: { id: "torch", count: 4 }, pattern: [[CO], [S]] },
    // 3 wood across the top + 2 sticks down the middle -> wooden pickaxe.
    { id: "pickaxe", gives: { id: "pickaxe", count: 1 }, table: true,
      pattern: [[W, W, W], [null, S, null], [null, S, null]] },
    // Same shape with stone across the top -> stone pickaxe.
    { id: "stone_pickaxe", gives: { id: "stone_pickaxe", count: 1 }, table: true,
      pattern: [[T, T, T], [null, S, null], [null, S, null]] },
    // Sticks down both sides + one in the middle -> 3 ladders.
    { id: "ladder", gives: { id: "ladder", count: 3 }, table: true,
      pattern: [[S, null, S], [S, S, S], [S, null, S]] },
    // Planks in a staircase -> 4 stairs. Walk straight up or down them, no
    // jumping needed.
    { id: "stairs", gives: { id: "stairs", count: 4 }, table: true,
      pattern: [[PL, null, null], [PL, PL, null], [PL, PL, PL]] },
    // Wood posts with sticks between -> 6 fences.
    { id: "fence", gives: { id: "fence", count: 6 }, table: true,
      pattern: [[W, S, W], [W, S, W]] },
    // Iron - redstone - iron -> a battery (long-lasting furnace fuel).
    { id: "battery", gives: { id: "battery", count: 1 }, table: true,
      pattern: [[IR], [RS], [IR]] },
    // Planks mattress over a wood frame -> a bed.
    { id: "bed", gives: { id: "bed", count: 1 }, table: true,
      pattern: [[PL, PL, PL], [W, W, W]] },
    // A ring of wood -> a chest.
    { id: "chest", gives: { id: "chest", count: 1 }, table: true,
      pattern: [[W, W, W], [W, null, W], [W, W, W]] },
    // Glass surrounded by wood -> a window.
    { id: "window", gives: { id: "window", count: 1 }, table: true,
      pattern: [[W, W, W], [W, G, W], [W, W, W]] },
    // 6 wood -> a plain door.
    { id: "door", gives: { id: "door", count: 1 }, table: true,
      pattern: [[W, W], [W, W], [W, W]] },
    // Glass over wood -> a door with a window.
    { id: "door_window", gives: { id: "door_window", count: 1 }, table: true,
      pattern: [[G, G], [W, W], [W, W]] },
    // Three stone in a V -> a bucket (for scooping up water).
    { id: "bucket", gives: { id: "bucket", count: 1 }, table: true,
      pattern: [[T, null, T], [null, T, null]] },
    // Three sugar canes in a row -> 3 paper.
    { id: "paper", gives: { id: "paper", count: 3 }, table: true,
      pattern: [["sugarcane", "sugarcane", "sugarcane"]] },
    // Paper over wood -> a book.
    { id: "book", gives: { id: "book", count: 1 }, pattern: [["paper"], [W]] },
    // A single piece of coal -> a chip of flint.
    { id: "flint", gives: { id: "flint", count: 1 }, pattern: [[CO]] },
    // Flint + steel -> flint & steel (lights a Nether portal).
    { id: "flint_and_steel", gives: { id: "flint_and_steel", count: 1 },
      pattern: [["flint", "steel"]] },
    // Four End Crystals in a square -> an Exit Portal (step through it to win).
    { id: "exit_portal", gives: { id: "exit_portal", count: 1 },
      pattern: [["end_crystal", "end_crystal"], ["end_crystal", "end_crystal"]] }
  ];

  // Painting recipes: wood + a paint -> coloured wood.
  ["red", "blue", "green", "yellow"].forEach((c) => {
    Game.Recipes.push({
      id: "wood_" + c, gives: { id: "wood_" + c, count: 1 },
      pattern: [[W, "paint_" + c]]
    });
  });

  // Armour & shield recipes (one per material, Minecraft-style shapes). "M" is
  // the material (planks / iron ingot / diamond). All need a crafting table.
  const ARMOR_SHAPES = {
    helmet:     (M) => [[M, M, M], [M, null, M]],
    chestplate: (M) => [[M, null, M], [M, M, M], [M, M, M]],
    leggings:   (M) => [[M, M, M], [M, null, M], [M, null, M]],
    boots:      (M) => [[M, null, M], [M, null, M]],
    shield:     (M) => [[M, M, M], [M, M, M], [null, M, null]]
  };
  Object.keys(Game.ARMOR_MATS).forEach((mk) => {
    const M = Game.ARMOR_MATS[mk].mat;
    Object.keys(ARMOR_SHAPES).forEach((pk) => {
      const id = mk + "_" + pk;
      Game.Recipes.push({ id: id, gives: { id: id, count: 1 }, table: true, pattern: ARMOR_SHAPES[pk](M) });
    });
  });

  // ---- Furnace smelting recipes ----------------------------------
  // input item id -> what you get out.
  Game.SmeltRecipes = {
    sand: { id: "glass", count: 1 },
    iron_ore: { id: "iron_ingot", count: 1 },
    iron_ingot: { id: "steel", count: 1 },
    gold_ore: { id: "gold_ingot", count: 1 },
    redstone_ore: { id: "redstone", count: 1 },
    diamond_ore: { id: "diamond", count: 1 },
    clay: { id: "brick", count: 1 },
    brown_clay: { id: "brown_brick", count: 1 },
    red_clay: { id: "red_brick", count: 1 },
    emerald_ore: { id: "emerald", count: 1 }
  };
  Game.canSmelt = (id) => !!Game.SmeltRecipes[id];
  Game.isFuel = (id) => !!(Game.ItemDefs[id] && Game.ItemDefs[id].fuel);
  Game.fuelValue = (id) => (Game.ItemDefs[id] ? (Game.ItemDefs[id].fuel || 0) : 0);

  // ---- Locked doors & keys ---------------------------------------
  // Each locked door block maps to the house number it guards; the matching
  // key item is "key" + that number. Tapping the door with the key unlocks it.
  Game.LOCKED = { locked_door_2: 2, locked_door_3: 3, locked_door_4: 4 };
  Game.keyForDoor = (id) => (Game.LOCKED[id] ? "key" + Game.LOCKED[id] : null);
  // Colours for each key's lock plate (drawn on the door) and key icon tint.
  Game.LOCK_COLORS = { 2: 0xb87333, 3: 0xb8c0c8, 4: 0xf2c14e };

  // ---- Villager trades -------------------------------------------
  // What a villager will sell you for emeralds.
  Game.Trades = [
    { cost: 1, gives: { id: "paint_red", count: 1 } },
    { cost: 1, gives: { id: "paint_blue", count: 1 } },
    { cost: 1, gives: { id: "paint_green", count: 1 } },
    { cost: 1, gives: { id: "paint_yellow", count: 1 } },
    { cost: 2, gives: { id: "glass", count: 4 } },
    { cost: 3, gives: { id: "window", count: 1 } },
    { cost: 4, gives: { id: "bed", count: 1 } }
  ];

})(window.Game);
