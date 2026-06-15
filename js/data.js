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
    REACH: 6,         // how many blocks away you can reach
    EYE: 1.62,        // camera height above the player's feet
    P_HALF: 0.3,      // player half-width (collision)
    P_HEIGHT: 1.8,    // player height (collision)
    GRAVITY: 26,      // blocks / s^2
    JUMP_V: 8.4,      // jump velocity
    MOVE_SPEED: 4.3,  // walking speed (blocks / s)
    TURN_SPEED: 1.9,  // turn speed (radians / s)
    FALL_SAFE: 3,     // falls shorter than this do no damage
    MAX_HP: 20,
    MAX_FOOD: 20
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
  const B = {
    grass:        { name: "Grass Block", top: 0x6abe46, side: 0x7d6a3f, bottom: 0x73553a, tool: "hand", drop: "grass" },
    dirt:         { name: "Dirt",        all: 0x7d5a36, tool: "hand", drop: "dirt" },
    sand:         { name: "Sand",        all: 0xe3d8a3, tool: "hand", drop: "sand" },
    stone:        { name: "Stone",       all: 0x8a8a8d, tool: "pickaxe", drop: "stone" },
    wood:         { name: "Wood",        top: 0x9c7a48, side: 0x6f5230, bottom: 0x9c7a48, tool: "hand", drop: "wood" },
    planks:       { name: "Wood Planks", all: 0xb18a4f, tool: "hand", drop: "planks" },
    leaves:       { name: "Leaves",      all: 0x3f9a3a, tool: "hand", drop: null },
    cactus:       { name: "Cactus",      all: 0x2f8b46, tool: "hand", drop: "cactus" },
    apple:        { name: "Apple",       all: 0xd23b32, tool: "hand", drop: "apple" },
    crafting_table:{ name: "Crafting Table", top: 0xa06a32, side: 0x8a5a2c, bottom: 0xb18a4f, tool: "hand", drop: "crafting_table" },
    coal_ore:     { name: "Coal Ore",    all: 0x4a4a4d, base: 0x8a8a8d, tool: "pickaxe", drop: "coal_ore" },
    iron_ore:     { name: "Iron Ore",    all: 0xb9846a, base: 0x8a8a8d, tool: "pickaxe", drop: "iron_ore" },
    gold_ore:     { name: "Gold Ore",    all: 0xe6c34a, base: 0x8a8a8d, tool: "pickaxe", drop: "gold_ore" },
    redstone_ore: { name: "Redstone Ore",all: 0xc0392b, base: 0x8a8a8d, tool: "pickaxe", drop: "redstone_ore" },
    diamond_ore:  { name: "Diamond Ore", all: 0x4fe3d8, base: 0x8a8a8d, tool: "pickaxe", drop: "diamond_ore" },
    emerald_ore:  { name: "Emerald Ore", all: 0x2ecc71, base: 0x8a8a8d, tool: "pickaxe", drop: "emerald_ore" }
  };

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
    d.solid = true;
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

  // ---- Item definitions (blocks + non-block items) ----------------
  // Non-block items: stick, pickaxe, and the food apple item.
  Game.ItemDefs = {};

  // Every block is also an item you can hold and place.
  Object.keys(B).forEach((id) => {
    Game.ItemDefs[id] = {
      name: B[id].name,
      swatch: B[id].top,    // little colour square used as the icon
      placeable: true
    };
  });

  // Special non-block items. NOTE: "apple" is also a world block, so this
  // MUST come after the loop above to override it — the apple you carry is
  // food you eat, not a block you place.
  Game.ItemDefs.stick   = { name: "Stick", emoji: "🥢", placeable: false };
  Game.ItemDefs.pickaxe = { name: "Wooden Pickaxe", emoji: "⛏️", placeable: false, tool: true };
  Game.ItemDefs.apple   = { name: "Apple", emoji: "🍎", placeable: false, food: 6 };

  Game.itemName = (id) => (Game.ItemDefs[id] ? Game.ItemDefs[id].name : id);
  Game.itemDef = (id) => Game.ItemDefs[id];
  Game.MAX_STACK = 99;

  // ---- Crafting recipes ------------------------------------------
  // need: ingredients consumed, gives: {id, count}, table: needs a table.
  Game.Recipes = [
    { id: "stick",          gives: { id: "stick", count: 4 },          need: { wood: 2 },             table: false },
    { id: "crafting_table", gives: { id: "crafting_table", count: 1 }, need: { wood: 4 },             table: false },
    { id: "planks",         gives: { id: "planks", count: 4 },         need: { wood: 1 },             table: false },
    { id: "pickaxe",        gives: { id: "pickaxe", count: 1 },        need: { stick: 2, wood: 3 },   table: true }
  ];

})(window.Game);
