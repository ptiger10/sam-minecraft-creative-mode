/* ===========================================================
   world.js — the blocky voxel world.
   Handles procedural generation, storage of blocks, rebuilding
   the render meshes (one InstancedMesh per block type), the
   voxel raycast used for aiming, and the wandering animals.
   =========================================================== */

(function (Game) {
  "use strict";

  const C = Game.CONST;

  // The world is meshed in square columns CHUNK blocks wide/deep (full height).
  // An edit only re-meshes the affected chunk (+ a neighbour if it sits on the
  // chunk's edge), instead of rebuilding the entire world every time.
  const CHUNK = 10;
  const chunkKey = (x, z) => Math.floor(x / CHUNK) + "," + Math.floor(z / CHUNK);

  // ---- Per-type cube geometry (vertex-coloured faces) ------------
  const geomCache = {};

  // Watermelon: a striped melon built from a segmented cube so the dark-green
  // stripes come straight from vertex colours (no texture needed). Light-green
  // rind with darker stripes down the sides; a plain light-green top & bottom.
  function watermelonGeometry() {
    const g = new THREE.BoxGeometry(1, 1, 1, 6, 6, 6);
    const pos = g.attributes.position, nor = g.attributes.normal;
    const light = new THREE.Color(0x8fd14a);   // light-green rind
    const dark = new THREE.Color(0x2f6b2a);    // dark-green stripe
    const cap = new THREE.Color(0x7fbf3f);     // top & bottom
    const colors = [];
    const STRIPES = 6;
    for (let i = 0; i < pos.count; i++) {
      let c = light;
      if (Math.abs(nor.getY(i)) > 0.5) {
        c = cap; // top / bottom faces
      } else {
        // vertical stripes: alternate bands across the side faces
        const h = Math.abs(nor.getX(i)) > Math.abs(nor.getZ(i)) ? pos.getZ(i) : pos.getX(i);
        const band = Math.floor((h + 0.5) * STRIPES + 0.0001);
        c = (band % 2 === 0) ? light : dark;
      }
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }

  // Ore blocks: a stone-coloured cube flecked with little specks of the ore's
  // colour, so each ore is easy to recognise underground (diamond's pale cyan,
  // gold's yellow, …). The specks come from vertex colours on a finely
  // subdivided cube — no textures needed — and are deterministic per ore type
  // so the pattern is stable but each ore looks different.
  function oreGeometry(id) {
    const def = Game.BlockDefs[id];
    const seg = 5;
    const g = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg);
    const pos = g.attributes.position;
    const stone = new THREE.Color(def.base);
    const ore = new THREE.Color(def.all);
    // Give each ore type its own speckle layout.
    let salt = 0;
    for (let i = 0; i < id.length; i++) salt = (salt * 31 + id.charCodeAt(i)) | 0;
    const colors = [];
    for (let i = 0; i < pos.count; i++) {
      // Snap the vertex to its cell on the cube so a whole speckle shares a colour.
      const gx = Math.round((pos.getX(i) + 0.5) * seg);
      const gy = Math.round((pos.getY(i) + 0.5) * seg);
      const gz = Math.round((pos.getZ(i) + 0.5) * seg);
      const c = Game.hash(salt ^ 0x5eed, gx, gy, gz) < 0.3 ? ore : stone;
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }

  // Ladder: instead of a plain cube, build a recognisable ladder shape — two
  // upright side rails joined by several rungs — by merging a handful of thin
  // boxes into one geometry. It sits as a flat panel through the middle of the
  // cell (thin front-to-back), so against a wall it reads clearly as a ladder.
  function ladderGeometry() {
    const def = Game.BlockDefs["ladder"];
    const rail = new THREE.Color(def.side);   // the two upright poles
    const rung = new THREE.Color(def.top);    // the steps between them
    const D = 0.14;        // thickness (front-to-back)
    const railW = 0.13;    // width of each upright rail
    const offX = 0.32;     // how far the rails sit from the centre
    const parts = [
      { g: new THREE.BoxGeometry(railW, 1.0, D), x: -offX, y: 0, z: 0, c: rail },
      { g: new THREE.BoxGeometry(railW, 1.0, D), x:  offX, y: 0, z: 0, c: rail },
    ];
    const RUNGS = 5;
    for (let i = 0; i < RUNGS; i++) {
      const y = -0.5 + (i + 0.5) / RUNGS;
      parts.push({ g: new THREE.BoxGeometry(2 * offX, 0.1, D * 0.8), x: 0, y: y, z: 0, c: rung });
    }
    return mergeColoredBoxes(parts);
  }

  // Merge several positioned, single-coloured box geometries into one
  // non-indexed BufferGeometry (so it can drive an InstancedMesh like the
  // other block types). Each part carries its own flat vertex colour.
  function mergeColoredBoxes(parts) {
    const geos = parts.map((p) => {
      const g = p.g.toNonIndexed();
      g.translate(p.x, p.y, p.z);
      return { g, c: p.c };
    });
    let total = 0;
    geos.forEach(({ g }) => { total += g.attributes.position.count; });
    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    let off = 0;
    geos.forEach(({ g, c }) => {
      const n = g.attributes.position.count;
      positions.set(g.attributes.position.array, off * 3);
      normals.set(g.attributes.normal.array, off * 3);
      for (let i = 0; i < n; i++) {
        colors[(off + i) * 3] = c.r;
        colors[(off + i) * 3 + 1] = c.g;
        colors[(off + i) * 3 + 2] = c.b;
      }
      off += n;
    });
    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    merged.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return merged;
  }

  const Box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

  // A fence: a central post with rails crossing through it, so it reads as a
  // proper fence rather than a solid cube.
  function fenceGeometry() {
    const def = Game.BlockDefs.fence;
    const post = new THREE.Color(def.side), rail = new THREE.Color(def.top);
    const D = 0.24;
    return mergeColoredBoxes([
      { g: Box(D, 1.0, D), x: 0, y: 0, z: 0, c: post },
      { g: Box(1.0, 0.15, D * 0.6), x: 0, y: 0.24, z: 0, c: rail },
      { g: Box(1.0, 0.15, D * 0.6), x: 0, y: -0.18, z: 0, c: rail },
      { g: Box(D * 0.6, 0.15, 1.0), x: 0, y: 0.24, z: 0, c: rail },
      { g: Box(D * 0.6, 0.15, 1.0), x: 0, y: -0.18, z: 0, c: rail }
    ]);
  }

  // A torch: a thin stick topped with a little glowing flame.
  function torchGeometry() {
    const def = Game.BlockDefs.torch;
    return mergeColoredBoxes([
      { g: Box(0.14, 0.6, 0.14), x: 0, y: -0.15, z: 0, c: new THREE.Color(def.side) },
      { g: Box(0.2, 0.2, 0.2), x: 0, y: 0.25, z: 0, c: new THREE.Color(def.top) }
    ]);
  }

  // A bed: a low wooden frame with a coloured mattress and a white pillow.
  function bedGeometry() {
    const def = Game.BlockDefs.bed;
    return mergeColoredBoxes([
      { g: Box(1.0, 0.3, 1.0), x: 0, y: -0.35, z: 0, c: new THREE.Color(def.bottom) },
      { g: Box(0.92, 0.2, 0.92), x: 0, y: -0.12, z: 0, c: new THREE.Color(def.top) },
      { g: Box(0.8, 0.16, 0.34), x: 0, y: 0.0, z: -0.3, c: new THREE.Color(0xf2f2f2) }
    ]);
  }

  // A window: a wooden frame around a glass pane. Open = just the frame.
  function windowGeometry(open) {
    const frame = new THREE.Color(Game.BlockDefs.window.top);
    const glass = new THREE.Color(Game.BlockDefs.window.all);
    const D = 0.18, T = 0.16;
    const parts = [
      { g: Box(1.0, T, D), x: 0, y: 0.42, z: 0, c: frame },
      { g: Box(1.0, T, D), x: 0, y: -0.42, z: 0, c: frame },
      { g: Box(T, 0.84, D), x: -0.42, y: 0, z: 0, c: frame },
      { g: Box(T, 0.84, D), x: 0.42, y: 0, z: 0, c: frame }
    ];
    if (!open) parts.push({ g: Box(0.84, 0.84, D * 0.4), x: 0, y: 0, z: 0, c: glass });
    return mergeColoredBoxes(parts);
  }

  // A door panel (thin in Z). Open swings it flat against the side (thin in X)
  // so you can walk through. door_window puts glass in its upper half.
  function doorGeometry(open, hasWindow) {
    const wood = new THREE.Color(Game.BlockDefs.door.all);
    const glass = new THREE.Color(Game.BlockDefs.glass.all);
    const handle = new THREE.Color(0x2e2113);
    const parts = [];
    if (!open) {
      if (hasWindow) {
        parts.push({ g: Box(0.92, 0.55, 0.16), x: 0, y: -0.2, z: 0, c: wood });
        parts.push({ g: Box(0.92, 0.4, 0.12), x: 0, y: 0.3, z: 0, c: glass });
      } else {
        parts.push({ g: Box(0.92, 0.98, 0.16), x: 0, y: 0, z: 0, c: wood });
      }
      parts.push({ g: Box(0.1, 0.1, 0.22), x: 0.32, y: 0, z: 0, c: handle });
    } else {
      if (hasWindow) {
        parts.push({ g: Box(0.16, 0.55, 0.92), x: -0.42, y: -0.2, z: 0, c: wood });
        parts.push({ g: Box(0.12, 0.4, 0.92), x: -0.42, y: 0.3, z: 0, c: glass });
      } else {
        parts.push({ g: Box(0.16, 0.98, 0.92), x: -0.42, y: 0, z: 0, c: wood });
      }
      parts.push({ g: Box(0.22, 0.1, 0.1), x: -0.42, y: 0, z: 0.32, c: handle });
    }
    return mergeColoredBoxes(parts);
  }

  // A chest: a wooden box with a darker lid band and a little latch.
  function chestGeometry() {
    const def = Game.BlockDefs.chest;
    const body = new THREE.Color(def.side), lid = new THREE.Color(def.top), latch = new THREE.Color(0x4a3018);
    return mergeColoredBoxes([
      { g: Box(0.92, 0.6, 0.84), x: 0, y: -0.18, z: 0, c: body },
      { g: Box(0.94, 0.3, 0.86), x: 0, y: 0.28, z: 0, c: lid },
      { g: Box(0.16, 0.18, 0.1), x: 0, y: 0.12, z: 0.44, c: latch }
    ]);
  }

  // A crafting table: a wooden block with a bright top carved into a 3×3 grid
  // of dark lines, so it stands out clearly from plain planks.
  function craftingTableGeometry() {
    const def = Game.BlockDefs.crafting_table;
    const body = new THREE.Color(def.side), top = new THREE.Color(def.top), line = new THREE.Color(0x4a2c12);
    return mergeColoredBoxes([
      { g: Box(1, 1, 1), x: 0, y: 0, z: 0, c: body },
      { g: Box(1.002, 0.14, 1.002), x: 0, y: 0.43, z: 0, c: top },
      { g: Box(1.02, 0.05, 0.06), x: 0, y: 0.5, z: -0.17, c: line },
      { g: Box(1.02, 0.05, 0.06), x: 0, y: 0.5, z: 0.17, c: line },
      { g: Box(0.06, 0.05, 1.02), x: -0.17, y: 0.5, z: 0, c: line },
      { g: Box(0.06, 0.05, 1.02), x: 0.17, y: 0.5, z: 0, c: line }
    ]);
  }

  // A furnace: a stone block dressed up so it reads at a glance — a lighter
  // stone cap and plinth, a row of rivets, and a glowing firebox with embers
  // and a grate on the front (+Z) face. Far more distinctive than a grey cube.
  function furnaceGeometry() {
    const def = Game.BlockDefs.furnace;
    const body = new THREE.Color(def.side);     // dark stone body
    const cap = new THREE.Color(def.top);       // lighter stone cap / plinth
    const trim = new THREE.Color(0x3a3a3d);     // dark iron trim
    const mouth = new THREE.Color(0x141417);    // the recessed firebox opening
    const ember = new THREE.Color(0xff7a1a);    // glowing coals
    const flame = new THREE.Color(0xffd23b);    // bright flame tips
    const rivet = new THREE.Color(0x9aa0a8);    // little metal studs
    const F = 0.5;                              // the front face sits at z = 0.5
    return mergeColoredBoxes([
      // Core block + a stone cap and base plinth so it has clear "top & bottom".
      { g: Box(1, 1, 1), x: 0, y: 0, z: 0, c: body },
      { g: Box(1.02, 0.16, 1.02), x: 0, y: 0.45, z: 0, c: cap },
      { g: Box(1.04, 0.12, 1.04), x: 0, y: -0.46, z: 0, c: cap },
      // A dark iron band wrapping the upper front.
      { g: Box(1.01, 0.2, 1.01), x: 0, y: 0.2, z: 0, c: trim },
      // Firebox: a recessed dark opening with glowing embers and a flame.
      { g: Box(0.66, 0.5, 0.06), x: 0, y: -0.14, z: F, c: mouth },
      { g: Box(0.54, 0.16, 0.05), x: 0, y: -0.3, z: F + 0.02, c: ember },
      { g: Box(0.3, 0.18, 0.05), x: 0, y: -0.12, z: F + 0.02, c: flame },
      // Two grate bars across the firebox mouth.
      { g: Box(0.06, 0.46, 0.04), x: -0.16, y: -0.14, z: F + 0.03, c: trim },
      { g: Box(0.06, 0.46, 0.04), x: 0.16, y: -0.14, z: F + 0.03, c: trim },
      // A row of rivets along the front, just under the cap.
      { g: Box(0.1, 0.1, 0.04), x: -0.34, y: 0.34, z: F + 0.01, c: rivet },
      { g: Box(0.1, 0.1, 0.04), x: 0, y: 0.34, z: F + 0.01, c: rivet },
      { g: Box(0.1, 0.1, 0.04), x: 0.34, y: 0.34, z: F + 0.01, c: rivet }
    ]);
  }

  // Stairs: a full-height back half with a lower front step, so it clearly
  // reads as something you walk up. (Collision is a normal cube — you auto-step
  // onto it — but the shape shows the slope.)
  function stairsGeometry() {
    const def = Game.BlockDefs.stairs;
    const lower = new THREE.Color(def.side), upper = new THREE.Color(def.top);
    return mergeColoredBoxes([
      { g: Box(1, 0.5, 1), x: 0, y: -0.25, z: 0, c: lower },   // bottom step (front)
      { g: Box(1, 0.5, 0.5), x: 0, y: 0.25, z: -0.25, c: upper } // upper step (back)
    ]);
  }

  // A locked door: a plain closed door with a coloured lock plate and keyhole,
  // so each house's lock visibly matches the key that opens it.
  function lockedDoorGeometry(num) {
    const wood = new THREE.Color(Game.BlockDefs.door.all);
    const plate = new THREE.Color((Game.LOCK_COLORS && Game.LOCK_COLORS[num]) || 0xb8c0c8);
    const hole = new THREE.Color(0x140f12);
    return mergeColoredBoxes([
      { g: Box(0.92, 0.98, 0.16), x: 0, y: 0, z: 0, c: wood },
      { g: Box(0.36, 0.36, 0.22), x: 0, y: 0.0, z: 0, c: plate },   // lock plate
      { g: Box(0.1, 0.18, 0.26), x: 0, y: -0.03, z: 0, c: hole }    // keyhole
    ]);
  }

  // A nether portal: a glowing purple block built as a cross of two thin panels
  // so it reads from every side. You walk into it to travel between worlds.
  function netherPortalGeometry() {
    const a = new THREE.Color(Game.BlockDefs.nether_portal.top);
    const b = new THREE.Color(Game.BlockDefs.nether_portal.all);
    return mergeColoredBoxes([
      { g: Box(0.86, 1.0, 0.2), x: 0, y: 0, z: 0, c: a },
      { g: Box(0.2, 1.0, 0.86), x: 0, y: 0, z: 0, c: b }
    ]);
  }

  // The "Hall of Fame" plaque: a gold-framed dark screen with a little star, on
  // the back wall of the fourth house. Tap it to roll the credits.
  function creditsBlockGeometry() {
    const frame = new THREE.Color(0xf2c14e), screen = new THREE.Color(0x16133a), star = new THREE.Color(0xffe9a8);
    return mergeColoredBoxes([
      { g: Box(1.0, 1.0, 0.5), x: 0, y: 0, z: -0.25, c: frame },     // gold frame
      { g: Box(0.84, 0.84, 0.14), x: 0, y: 0, z: 0.06, c: screen },  // dark screen (+z)
      { g: Box(0.2, 0.2, 0.08), x: 0, y: 0.16, z: 0.16, c: star }    // a little star
    ]);
  }

  function blockGeometry(id) {
    if (geomCache[id]) return geomCache[id];
    if (id === "nether_portal") return (geomCache[id] = netherPortalGeometry());
    if (id === "credits_block") return (geomCache[id] = creditsBlockGeometry());
    if (Game.LOCKED && Game.LOCKED[id]) return (geomCache[id] = lockedDoorGeometry(Game.LOCKED[id]));
    if (id === "stairs") return (geomCache[id] = stairsGeometry());
    if (id === "furnace") return (geomCache[id] = furnaceGeometry());
    if (id === "crafting_table") return (geomCache[id] = craftingTableGeometry());
    if (id === "watermelon") return (geomCache[id] = watermelonGeometry());
    if (id === "ladder") return (geomCache[id] = ladderGeometry());
    if (id === "fence") return (geomCache[id] = fenceGeometry());
    if (id === "torch") return (geomCache[id] = torchGeometry());
    if (id === "bed") return (geomCache[id] = bedGeometry());
    if (id === "chest") return (geomCache[id] = chestGeometry());
    if (id === "window") return (geomCache[id] = windowGeometry(false));
    if (id === "window_open") return (geomCache[id] = windowGeometry(true));
    if (id === "door") return (geomCache[id] = doorGeometry(false, false));
    if (id === "door_open") return (geomCache[id] = doorGeometry(true, false));
    if (id === "door_window") return (geomCache[id] = doorGeometry(false, true));
    if (id === "door_window_open") return (geomCache[id] = doorGeometry(true, true));
    const def = Game.BlockDefs[id];
    if (def && def.base !== undefined) return (geomCache[id] = oreGeometry(id));
    const g = new THREE.BoxGeometry(1, 1, 1);
    const colors = [];
    // BoxGeometry face/group order: +X, -X, +Y(top), -Y(bottom), +Z, -Z
    const faceCol = [def.side, def.side, def.top, def.bottom, def.side, def.side];
    for (let f = 0; f < 6; f++) {
      const c = new THREE.Color(faceCol[f]);
      for (let v = 0; v < 4; v++) colors.push(c.r, c.g, c.b); // 4 verts per face
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geomCache[id] = g;
    return g;
  }

  // ---- The World -------------------------------------------------
  function World(scene, seed, biome) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.biome = biome; // "forest" | "desert"
    this.blocks = new Map();         // "x,y,z" -> block id
    this.changes = new Map();        // edits since generation (for saving)
    this.chunkBlocks = new Map();    // chunkKey -> Set of "x,y,z" (blocks per chunk)
    this.meshChunks = new Map();     // chunkKey -> { block id -> InstancedMesh }
    this.dirtyChunks = new Set();    // chunks awaiting a re-mesh
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.rebuildQueued = false;
    this.spawn = { x: C.WORLD / 2, y: 0, z: C.WORLD / 2 };
    this.animals = [];
    this.trees = [];                 // trunk tops, so monkeys can swing in them
    this.protectedCells = new Set(); // quest-house shells you can't mine through
  }

  World.key = (x, y, z) => x + "," + y + "," + z;

  // Quest structures (the locked houses) are sealed: their walls, roof, floor
  // and door can't be mined, so the only way in is the matching key.
  World.prototype.markProtected = function (x, y, z) {
    this.protectedCells.add(World.key(x, y, z));
  };
  World.prototype.isProtected = function (x, y, z) {
    return this.protectedCells.has(World.key(x, y, z));
  };

  World.prototype.get = function (x, y, z) {
    return this.blocks.get(World.key(x, y, z)) || null;
  };

  // A cell counts as "occupied" only if a real block is there.
  World.prototype.occupied = function (x, y, z) {
    return this.blocks.has(World.key(x, y, z));
  };

  // Collision solidity: real *solid* blocks (water/torches/open doors are not),
  // the floor, and the invisible world walls.
  World.prototype.solidAt = function (x, y, z) {
    if (y < 0) return true; // bedrock floor — you cannot fall through
    if (x < 0 || x >= C.WORLD || z < 0 || z >= C.WORLD) return true; // edge walls
    const id = this.blocks.get(World.key(x, y, z));
    return !!(id && Game.isSolidBlock(id));
  };

  // Highest solid block in a column (animals & spawning stand on solid ground,
  // not on the surface of a pond).
  World.prototype.surfaceY = function (x, z) {
    for (let y = C.MAX_Y; y >= 0; y--) {
      const id = this.blocks.get(World.key(x, y, z));
      if (id && Game.isSolidBlock(id)) return y;
    }
    return 0;
  };

  // Can a wandering animal stand at this spot? It must be in bounds and free of
  // solid blocks at foot + body height — so a fence (a solid block) pens it in.
  World.prototype.canStand = function (x, z, y) {
    if (x < 2 || x >= C.WORLD - 2 || z < 2 || z >= C.WORLD - 2) return false;
    const fx = Math.floor(x), fz = Math.floor(z), fy = Math.floor(y);
    if (this.solidAt(fx, fy, fz)) return false;
    if (this.solidAt(fx, fy + 1, fz)) return false;
    return true;
  };

  // ---- Generation ------------------------------------------------
  World.prototype.generate = function () {
    const height = Game.makeHeight(this.seed);
    const desert = this.biome === "desert";
    const WATER = C.WATER_LEVEL;
    const cx = Math.floor(C.WORLD / 2), cz = Math.floor(C.WORLD / 2);
    const nearSpawn = (x, z) => Math.abs(x - cx) <= 3 && Math.abs(z - cz) <= 3;

    // Precompute clamped heights so we can find ponds (and their shores).
    const H = [];
    for (let x = 0; x < C.WORLD; x++) {
      H[x] = [];
      for (let z = 0; z < C.WORLD; z++) {
        H[x][z] = Math.max(2, Math.min(C.MAX_Y - 6, height(x, z)));
      }
    }
    // A column floods if it dips below the water line (kept away from spawn so
    // you never start in a puddle). Deserts stay dry.
    const isWater = (x, z) => {
      if (x < 0 || x >= C.WORLD || z < 0 || z >= C.WORLD) return false;
      return !desert && !nearSpawn(x, z) && H[x][z] < WATER;
    };
    this._isWater = isWater;

    for (let x = 0; x < C.WORLD; x++) {
      for (let z = 0; z < C.WORLD; z++) {
        const h = H[x][z];
        const water = isWater(x, z);
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === h) {
            if (water) id = Game.hash(this.seed ^ 0xc1a7, x, 0, z) < 0.5 ? "clay" : "sand"; // pond bed
            else if (desert) id = this.desertSurface(x, z);
            else id = "grass";
          } else if (y >= h - 2) {
            id = desert ? "sand" : "dirt";
          } else {
            id = this.pickStone(x, y, z);
          }
          this.blocks.set(World.key(x, y, z), id);
        }
        // Fill the pond with water up to the water line.
        if (water) for (let y = h + 1; y <= WATER; y++) this.blocks.set(World.key(x, y, z), "water");
        // Vegetation sits on top of dry land only.
        if (!water) this.maybeVegetation(x, z, h, desert);
      }
    }

    // Sandy shore: any land block right beside the water becomes sand.
    for (let x = 0; x < C.WORLD; x++) {
      for (let z = 0; z < C.WORLD; z++) {
        if (isWater(x, z)) continue;
        const h = H[x][z];
        if (h < WATER - 1 || h > WATER + 1) continue;
        if (isWater(x + 1, z) || isWater(x - 1, z) || isWater(x, z + 1) || isWater(x, z - 1)) {
          if (!this.occupied(x, h + 1, z)) {
            this.blocks.set(World.key(x, h, z), "sand");
            // Sugar cane sprouts along the water's edge, 1–2 blocks tall.
            if (Game.hash(this.seed ^ 0x5ca9e, x, 0, z) < 0.4) {
              const tall = 1 + Math.floor(Game.hash(this.seed ^ 0x5ca9e, x, 7, z) * 2);
              for (let i = 0; i < tall; i++) this.blocks.set(World.key(x, h + 1 + i, z), "sugarcane");
            }
          }
        }
      }
    }

    // Spawn the player on top of the centre column.
    const sx = Math.floor(C.WORLD / 2), sz = Math.floor(C.WORLD / 2);
    this.spawn = { x: sx + 0.5, y: this.surfaceY(sx, sz) + 1, z: sz + 0.5 };

    this.spawnAnimals(desert ? 3 : 4);
    // Four settlements joined by a yellow brick road, with the quest villagers.
    this.buildQuestWorld();
  };

  // Desert surface is mostly sand, with the odd patch of coloured clay.
  World.prototype.desertSurface = function (x, z) {
    const r = Game.hash(this.seed ^ 0x7e44a, x, 0, z);
    if (r < 0.04) return "red_clay";
    if (r < 0.075) return "brown_clay";
    return "sand";
  };

  // Stone, or an ore — rarer + special ores appear deeper.
  World.prototype.pickStone = function (x, y, z) {
    // Clay pockets (hand-diggable) scattered through the ground in every biome.
    const rc = Game.hash(this.seed ^ 0xc1a77, x, y, z);
    if (rc < 0.012) return "clay";
    if (rc < 0.020) return "brown_clay";
    if (rc < 0.026) return "red_clay";
    const r = Game.hash(this.seed, x, y, z);
    const deep = y < 6; // closer to bedrock — richer in diamond & emerald
    if (r < 0.010) return "coal_ore";
    if (r < 0.018) return "iron_ore";
    if (r < 0.024) return "gold_ore";
    if (r < 0.030) return "redstone_ore";
    // Diamonds & emeralds are rare everywhere (so you can find some by digging
    // almost anywhere) and a bit richer down deep. Mine them with a pickaxe.
    if (r < (deep ? 0.040 : 0.033)) return "diamond_ore";
    if (r < (deep ? 0.045 : 0.036)) return "emerald_ore";
    return "stone";
  };

  // Trees, apple trees and cacti — deterministic from the seed.
  World.prototype.maybeVegetation = function (x, z, h, desert) {
    // keep vegetation away from the very edges
    if (x < 2 || z < 2 || x >= C.WORLD - 2 || z >= C.WORLD - 2) return;
    // keep a clearing around the spawn point so you never start stuck in a tree
    const cx = Math.floor(C.WORLD / 2), cz = Math.floor(C.WORLD / 2);
    if (Math.abs(x - cx) <= 2 && Math.abs(z - cz) <= 2) return;
    const r = Game.hash(this.seed ^ 0x55aa, x, 0, z);

    if (desert) {
      if (r < 0.05) this.placeCactus(x, h + 1, z);
      else if (r < 0.065) this.blocks.set(World.key(x, h + 1, z), "watermelon"); // melons in the sand
      else if (r > 0.985) this.placeTree(x, h + 1, z, true); // rare oasis apple tree
      return;
    }

    // Forest: lots of trees, ~1/3 of them bearing apples, plus melons on the ground.
    if (r < 0.12) {
      const apple = Game.hash(this.seed ^ 0x1234, x, 1, z) < 0.4;
      this.placeTree(x, h + 1, z, apple);
    } else if (r < 0.145) {
      this.blocks.set(World.key(x, h + 1, z), "watermelon");
    }
  };

  World.prototype.placeCactus = function (x, y, z) {
    const tall = 2 + Math.floor(Game.hash(this.seed, x, 5, z) * 2);
    for (let i = 0; i < tall; i++) this.blocks.set(World.key(x, y + i, z), "cactus");
  };

  World.prototype.placeTree = function (x, y, z, apple) {
    const trunk = 4 + Math.floor(Game.hash(this.seed, x, 9, z) * 2);
    for (let i = 0; i < trunk; i++) this.blocks.set(World.key(x, y + i, z), "wood");
    const top = y + trunk;
    // Leaf canopy: a little 3x3x3-ish blob around the top of the trunk.
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          const dist = Math.abs(dx) + Math.abs(dz) + Math.abs(dy);
          if (dist > 3) continue;
          const lx = x + dx, ly = top + dy, lz = z + dz;
          if (this.occupied(lx, ly, lz)) continue; // don't overwrite the trunk
          // Sprinkle apples on the edge of apple-tree canopies — more of them on
          // the lower edge (dy < 0) so they're easier to see and reach.
          let id = "leaves";
          if (apple && dist >= 2) {
            const chance = dy < 0 ? 0.5 : 0.28;
            if (Game.hash(this.seed, lx, ly, lz) < chance) id = "apple";
          }
          this.blocks.set(World.key(lx, ly, lz), id);
        }
      }
    }
    // a leaf cap on top
    if (!this.occupied(x, top + 1, z)) this.blocks.set(World.key(x, top + 1, z), "leaves");

    // Apple trees also dangle a few apples low around the trunk (about eye
    // level) so even little explorers can reach one without climbing.
    if (apple) {
      const hangY = top - 2;
      const ring = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let i = 0; i < ring.length; i++) {
        const ax = x + ring[i][0], az = z + ring[i][1];
        if (this.occupied(ax, hangY, az)) continue;
        if (Game.hash(this.seed ^ 0x5a17, ax, hangY, az) < 0.55) {
          this.blocks.set(World.key(ax, hangY, az), "apple");
        }
      }
    }

    // Remember the tree so a monkey can come and swing in its canopy.
    this.trees.push({ x: x, z: z, top: top });
  };

  // ---- Editing ---------------------------------------------------
  World.prototype.setBlock = function (x, y, z, id, record) {
    const k = World.key(x, y, z);
    if (id) { this.blocks.set(k, id); this.indexAdd(k, x, z); }
    else { this.blocks.delete(k); this.indexRemove(k, x, z); }
    if (record !== false) this.changes.set(k, id || null);
    this.markDirty(x, y, z);
  };

  // Keep the per-chunk block index in step with edits.
  World.prototype.indexAdd = function (key, x, z) {
    const ck = chunkKey(x, z);
    let s = this.chunkBlocks.get(ck);
    if (!s) { s = new Set(); this.chunkBlocks.set(ck, s); }
    s.add(key);
  };
  World.prototype.indexRemove = function (key, x, z) {
    const s = this.chunkBlocks.get(chunkKey(x, z));
    if (s) s.delete(key);
  };

  // Rebuild the whole per-chunk index from the block map (called before a
  // full mesh build, after generation / loading edits straight into blocks).
  World.prototype.reindex = function () {
    this.chunkBlocks = new Map();
    this.blocks.forEach((id, key) => {
      const c1 = key.indexOf(","), c2 = key.lastIndexOf(",");
      this.indexAdd(key, +key.slice(0, c1), +key.slice(c2 + 1));
    });
  };

  // Flag the chunk holding (x,y,z) — and a neighbour if the block is on the
  // chunk's edge, since that changes the neighbour's face exposure.
  World.prototype.markDirty = function (x, y, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    this.dirtyChunks.add(cx + "," + cz);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    if (lx === 0)         this.dirtyChunks.add((cx - 1) + "," + cz);
    if (lx === CHUNK - 1) this.dirtyChunks.add((cx + 1) + "," + cz);
    if (lz === 0)         this.dirtyChunks.add(cx + "," + (cz - 1));
    if (lz === CHUNK - 1) this.dirtyChunks.add(cx + "," + (cz + 1));
    this.queueRebuild();
  };

  World.prototype.applyChanges = function (changeArray) {
    changeArray.forEach((c) => {
      const k = World.key(c.x, c.y, c.z);
      if (c.id) this.blocks.set(k, c.id);
      else this.blocks.delete(k);
      this.changes.set(k, c.id || null);
    });
  };

  // ---- Meshing ---------------------------------------------------
  // A block is drawn only if at least one of its six neighbours is empty.
  World.prototype.isExposed = function (x, y, z) {
    return !this.occupied(x + 1, y, z) || !this.occupied(x - 1, y, z) ||
           !this.occupied(x, y + 1, z) || !this.occupied(x, y - 1, z) ||
           !this.occupied(x, y, z + 1) || !this.occupied(x, y, z - 1);
  };

  World.prototype.queueRebuild = function () {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    requestAnimationFrame(() => { this.rebuildQueued = false; this.rebuildDirty(); });
  };

  // Re-mesh only the chunks touched since the last frame.
  World.prototype.rebuildDirty = function () {
    this.dirtyChunks.forEach((ck) => this.buildChunk(ck));
    this.dirtyChunks.clear();
  };

  // Full (re)build of every chunk — used once when a world is started/loaded.
  World.prototype.buildMeshes = function () {
    this.reindex();
    this.dirtyChunks.clear();
    this.chunkBlocks.forEach((_set, ck) => this.buildChunk(ck));
  };

  // Rebuild the InstancedMeshes for a single chunk from its exposed blocks.
  World.prototype.buildChunk = function (ck) {
    const set = this.chunkBlocks.get(ck);
    let meshMap = this.meshChunks.get(ck);

    // Group this chunk's exposed blocks by type.
    const byType = {};
    if (set) {
      set.forEach((key) => {
        const id = this.blocks.get(key);
        if (!id) return;
        const c1 = key.indexOf(","), c2 = key.lastIndexOf(",");
        const x = +key.slice(0, c1), y = +key.slice(c1 + 1, c2), z = +key.slice(c2 + 1);
        if (!this.isExposed(x, y, z)) return;
        (byType[id] || (byType[id] = [])).push(x, y, z);
      });
    }

    if (!meshMap) { meshMap = {}; this.meshChunks.set(ck, meshMap); }

    // Drop this chunk's meshes for types it no longer contains.
    Object.keys(meshMap).forEach((id) => {
      if (!byType[id]) {
        this.scene.remove(meshMap[id]);
        meshMap[id].dispose();
        delete meshMap[id];
      }
    });

    const m = new THREE.Matrix4();
    Object.keys(byType).forEach((id) => {
      const coords = byType[id];
      const count = coords.length / 3;
      let mesh = meshMap[id];
      if (!mesh || mesh.userData.cap < count) {
        if (mesh) { this.scene.remove(mesh); mesh.dispose(); }
        const cap = Math.ceil(count * 1.3) + 16;
        mesh = new THREE.InstancedMesh(blockGeometry(id), this.material, cap);
        mesh.userData.cap = cap;
        mesh.frustumCulled = false; // many small static meshes; skip culling
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(mesh);
        meshMap[id] = mesh;
      }
      for (let i = 0; i < count; i++) {
        m.setPosition(coords[i * 3] + 0.5, coords[i * 3 + 1] + 0.5, coords[i * 3 + 2] + 0.5);
        mesh.setMatrixAt(i, m);
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    });
  };

  // ---- Voxel raycast (Amanatides & Woo DDA) ----------------------
  // Returns the first solid block hit and the empty cell just before
  // it (where a new block would be placed).
  World.prototype.raycast = function (origin, dir) {
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepY = dir.y > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / (dir.x || 1e-9));
    const tDeltaY = Math.abs(1 / (dir.y || 1e-9));
    const tDeltaZ = Math.abs(1 / (dir.z || 1e-9));
    const bx = dir.x > 0 ? x + 1 - origin.x : origin.x - x;
    const by = dir.y > 0 ? y + 1 - origin.y : origin.y - y;
    const bz = dir.z > 0 ? z + 1 - origin.z : origin.z - z;
    let tMaxX = tDeltaX * bx;
    let tMaxY = tDeltaY * by;
    let tMaxZ = tDeltaZ * bz;
    let px = x, py = y, pz = z;

    for (let i = 0; i < C.REACH * 3; i++) {
      if (this.occupied(x, y, z)) {
        return { block: { x: x, y: y, z: z }, place: { x: px, y: py, z: pz } };
      }
      px = x; py = y; pz = z;
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        if (tMaxX > C.REACH) break;
        x += stepX; tMaxX += tDeltaX;
      } else if (tMaxY < tMaxZ) {
        if (tMaxY > C.REACH) break;
        y += stepY; tMaxY += tDeltaY;
      } else {
        if (tMaxZ > C.REACH) break;
        z += stepZ; tMaxZ += tDeltaZ;
      }
    }
    return null;
  };

  // ---- Animals (cannot be hurt) ----------------------------------
  // Ground critters share one blocky builder — they only differ in colour and
  // proportions. The monkey is special and is built separately (it hangs).
  const GROUND_KINDS = ["pig", "sheep", "donkey", "horse", "dog"];
  const ANIMALS = {
    pig:    { body: 0xeaa1a8, head: 0xe88f98, leg: 0xc77f86, snout: 0xd97f88, size: 1.00, legLen: 0.40, ears: "none",   mane: false, tail: true },
    sheep:  { body: 0xefe9da, head: 0xdcd6c4, leg: 0xb9b3a2, snout: 0xdcd6c4, size: 1.00, legLen: 0.40, ears: "none",   mane: false, tail: false },
    donkey: { body: 0x9a8c7a, head: 0x8a7c6a, leg: 0x6f6457, snout: 0x6f6457, size: 1.05, legLen: 0.54, ears: "long",   mane: false, tail: true },
    horse:  { body: 0x8a5a32, head: 0x7a4e2a, leg: 0x5f3f22, snout: 0x6a4426, size: 1.18, legLen: 0.64, ears: "pointy", mane: true,  tail: true },
    dog:    { body: 0xc08a4f, head: 0xc9945a, leg: 0xa5743f, snout: 0x5e4126, size: 0.70, legLen: 0.32, ears: "pointy", mane: false, tail: true }
  };

  function makeAnimal(kind) {
    if (kind === "monkey") return makeMonkey();
    const s = ANIMALS[kind] || ANIMALS.pig;
    const sz = s.size;
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9 * sz, 0.55 * sz, 0.5 * sz), mat(s.body));
    body.position.y = s.legLen + 0.28 * sz;
    group.add(body);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42 * sz, 0.42 * sz, 0.42 * sz), mat(s.head));
    head.position.set(0.55 * sz, s.legLen + 0.46 * sz, 0);
    group.add(head);

    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.16 * sz, 0.18 * sz, 0.24 * sz), mat(s.snout));
    snout.position.set(0.8 * sz, s.legLen + 0.37 * sz, 0);
    group.add(snout);

    if (s.ears !== "none") {
      const long = s.ears === "long";
      const earGeo = new THREE.BoxGeometry(0.09 * sz, (long ? 0.3 : 0.14) * sz, 0.09 * sz);
      [-0.13, 0.13].forEach((dz) => {
        const ear = new THREE.Mesh(earGeo, mat(s.head));
        ear.position.set(0.5 * sz, s.legLen + (long ? 0.74 : 0.66) * sz, dz * sz);
        group.add(ear);
      });
    }

    if (s.mane) {
      const mane = new THREE.Mesh(new THREE.BoxGeometry(0.12 * sz, 0.34 * sz, 0.42 * sz), mat(0x3a2615));
      mane.position.set(0.34 * sz, s.legLen + 0.6 * sz, 0);
      group.add(mane);
    }

    const legGeo = new THREE.BoxGeometry(0.16 * sz, s.legLen, 0.16 * sz);
    [[0.3, 0.16], [0.3, -0.16], [-0.3, 0.16], [-0.3, -0.16]].forEach((o) => {
      const leg = new THREE.Mesh(legGeo, mat(s.leg));
      leg.position.set(o[0] * sz, s.legLen / 2, o[1] * sz);
      group.add(leg);
    });

    if (s.tail) {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3 * sz, 0.09 * sz, 0.09 * sz), mat(s.leg));
      tail.position.set(-0.58 * sz, s.legLen + 0.3 * sz, 0);
      group.add(tail);
    }

    group.userData.kind = kind;
    return group;
  }

  // A little monkey that hangs by its arms — built around its own centre so it
  // can sway like it's swinging from a branch.
  function makeMonkey() {
    const group = new THREE.Group();
    const fur = 0x6e4a2b, face = 0xc8a274;
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

    group.add(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.48, 0.26), mat(fur)));

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.28), mat(fur));
    head.position.y = 0.4;
    group.add(head);

    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 0.06), mat(face));
    muzzle.position.set(0, 0.37, 0.15);
    group.add(muzzle);

    [-0.18, 0.18].forEach((dx) => {
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.05), mat(fur));
      ear.position.set(dx, 0.45, 0);
      group.add(ear);
    });

    // arms raised overhead, gripping the branch
    [-0.24, 0.24].forEach((dx) => {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.44, 0.09), mat(fur));
      arm.position.set(dx, 0.42, 0);
      arm.rotation.z = dx > 0 ? -0.55 : 0.55;
      group.add(arm);
    });

    // dangling legs
    [-0.09, 0.09].forEach((dx) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.34, 0.09), mat(fur));
      leg.position.set(dx, -0.36, 0);
      group.add(leg);
    });

    // long curling tail
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.5, 0.07), mat(fur));
    tail.position.set(-0.22, -0.06, 0);
    tail.rotation.z = 0.9;
    group.add(tail);

    group.userData.kind = "monkey";
    return group;
  }

  // A blocky villager: a robed townsperson with a big nose, who you can trade
  // with for emeralds. Walks the ground like the other critters.
  function makeVillager() {
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const robe = 0x5f7a4a, head = 0xc89a78, nose = 0xa9785a;
    [-0.12, 0.12].forEach((dx) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.5, 0.2), mat(0x46402f));
      leg.position.set(dx, 0.25, 0); group.add(leg);
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.32), mat(robe));
    body.position.y = 0.85; group.add(body);
    [-0.32, 0.32].forEach((dx) => {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.6, 0.18), mat(robe));
      arm.position.set(dx, 0.85, 0); group.add(arm);
    });
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), mat(head));
    h.position.y = 1.42; group.add(h);
    const n = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.24, 0.18), mat(nose));
    n.position.set(0, 1.38, 0.26); group.add(n);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.08, 0.05), mat(0x5a4636));
    brow.position.set(0, 1.55, 0.21); group.add(brow);
    group.userData.kind = "villager";
    return group;
  }
  World.makeVillager = makeVillager;

  // A ghast: a big pale floating jelly-cube with a sad face and nine dangling
  // tentacles. It drifts overhead in the Nether and spits fireballs at you.
  function makeGhast() {
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const bodyC = 0xf2efe9, faceC = 0x37343a, tentC = 0xd9d4c8;
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), mat(bodyC)));
    [-0.28, 0.28].forEach((x) => {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.06), mat(faceC));
      e.position.set(x, 0.12, 0.56); group.add(e);
    });
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.06), mat(faceC));
    mouth.position.set(0, -0.28, 0.56); group.add(mouth);
    let i = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const len = 0.45 + ((i * 7) % 5) * 0.13; i++;
        const t = new THREE.Mesh(new THREE.BoxGeometry(0.15, len, 0.15), mat(tentC));
        t.position.set(dx * 0.34, -0.55 - len / 2 + 0.1, dz * 0.34); group.add(t);
      }
    }
    group.userData.kind = "ghast";
    return group;
  }
  World.makeGhast = makeGhast;

  // Fill a single column from fromY..toY (inclusive) with one block id.
  World.prototype.fillColumn = function (x, z, fromY, toY, id) {
    if (x < 0 || z < 0 || x >= C.WORLD || z >= C.WORLD) return;
    for (let y = fromY; y <= toY; y++) this.blocks.set(World.key(x, y, z), id);
  };

  // The settlement: a paved keep ringed by a low wall, with four soaring corner
  // spires and a central beacon mast that all rise WELL above the treetops, so
  // the village is unmistakable when you scan the horizon from a treetop.
  World.prototype.buildSettlement = function (cx, cz, rng) {
    const R = 5;                                  // half-width of the keep
    const floorY = this.surfaceY(cx, cz);         // flatten everything to here
    const wallTop = floorY + 3;                   // a low, homely perimeter wall
    const spireTop = C.MAX_Y - 1;                 // corner spires nearly touch the sky
    const mastTop = C.MAX_Y + 1;                  // the central mast is the tallest of all

    // 1) Flatten + pave the plaza, clearing any trees that stood here.
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const x = cx + dx, z = cz + dz;
        if (x < 1 || z < 1 || x >= C.WORLD - 1 || z >= C.WORLD - 1) continue;
        for (let y = floorY + 1; y <= C.MAX_Y + 3; y++) this.blocks.delete(World.key(x, y, z));
        this.fillColumn(x, z, Math.max(0, floorY - 1), floorY - 1, "dirt");
        this.blocks.set(World.key(x, floorY, z), "planks"); // a wooden plaza floor
      }
    }

    // 2) Perimeter wall with windows, leaving a doorway on the +z side.
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue; // edge cells only
        const x = cx + dx, z = cz + dz;
        if (x < 1 || z < 1 || x >= C.WORLD - 1 || z >= C.WORLD - 1) continue;
        if (dz === R && Math.abs(dx) <= 1) continue;             // open doorway
        this.fillColumn(x, z, floorY + 1, wallTop, "brown_brick");
        // a glass window every other block along the wall
        if ((Math.abs(dx) + Math.abs(dz)) % 2 === 0) {
          this.blocks.set(World.key(x, floorY + 2, z), "glass");
        }
      }
    }

    // 3) Four tall corner spires, each topped with a bright beacon you can spot
    //    from far away (a coloured block crowned with a glowing torch).
    const corners = [[-R, -R], [R, -R], [-R, R], [R, R]];
    corners.forEach(([dx, dz]) => {
      const x = cx + dx, z = cz + dz;
      if (x < 1 || z < 1 || x >= C.WORLD - 1 || z >= C.WORLD - 1) return;
      this.fillColumn(x, z, floorY + 1, spireTop - 1, "brick");
      this.blocks.set(World.key(x, spireTop, z), "wood_red"); // bright crown
      if (spireTop + 1 <= C.MAX_Y) this.blocks.set(World.key(x, spireTop + 1, z), "torch");
    });

    // 4) The central beacon mast — the very tallest point of the settlement.
    this.fillColumn(cx, cz, floorY + 1, Math.min(C.MAX_Y, mastTop - 1), "brick");
    if (mastTop - 2 >= floorY + 1) this.blocks.set(World.key(cx, mastTop - 2, cz), "wood_yellow");
    const beaconY = Math.min(C.MAX_Y, mastTop);
    this.blocks.set(World.key(cx, beaconY, cz), "torch");

    return floorY;
  };

  World.prototype.spawnVillagers = function (count) {
    const rng = Game.mulberry32(this.seed ^ 0x711a9e);
    // The villagers share one settlement and stay close to it. Keep it clear of
    // the player's spawn (world centre) so nobody starts buried under a tower.
    const sc = Math.floor(C.WORLD / 2);
    let cx = sc, cz = sc, tries = 0;
    do {
      cx = 8 + Math.floor(rng() * (C.WORLD - 16));
      cz = 8 + Math.floor(rng() * (C.WORLD - 16));
      tries++;
    } while (tries < 40 && Math.abs(cx - sc) < 10 && Math.abs(cz - sc) < 10);

    const floorY = this.buildSettlement(cx, cz, rng);

    // Spots inside the keep (clear of the central mast and the corner spires)
    // where the villagers stand and amble about.
    const spots = [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [3, -1], [-3, 1]];
    for (let i = 0; i < count; i++) {
      const v = makeVillager();
      const off = spots[i % spots.length];
      const x = cx + off[0], z = cz + off[1];
      v.position.set(x + 0.5, floorY + 1, z + 0.5);
      v.userData.home = { x: cx + 0.5, z: cz + 0.5 }; // the settlement centre
      v.userData.roam = 3.5;                          // stay inside the walls
      v.userData.dir = rng() * Math.PI * 2;
      v.userData.timer = rng() * 4;
      v.userData.moving = false;
      this.animals.push(v);
    }
  };

  // ================================================================
  //  The quest: four settlements joined by a yellow brick road.
  // ================================================================
  World.prototype.buildQuestWorld = function () {
    const sc = Math.floor(C.WORLD / 2); // spawn / world centre
    // Four settlement centres around the spawn, each more elaborate than the last.
    const sites = [
      { cx: 9,  cz: sc, level: 1 },
      { cx: sc, cz: 9,  level: 2 },
      { cx: C.WORLD - 9, cz: sc, level: 3 },
      { cx: sc, cz: C.WORLD - 9, level: 4 }
    ];
    this.questSites = sites;

    // The yellow brick road starts at the spawn and links the settlements in
    // order: spawn -> 1 -> 2 -> 3 -> 4.
    this.layRoad(sc, sc, sites[0].cx, sites[0].cz, sites);
    for (let i = 0; i < sites.length - 1; i++) {
      this.layRoad(sites[i].cx, sites[i].cz, sites[i + 1].cx, sites[i + 1].cz, sites);
    }

    this.questVillagers = [];
    this.questPortalExit = null;
    sites.forEach((s, i) => this.buildQuestSettlement(s.cx, s.cz, s.level, i + 1));
  };

  // True if (x,z) sits within (or just outside) a settlement's footprint.
  World.prototype.insideSite = function (x, z, sites, pad) {
    pad = pad || 0;
    return sites.some((s) => Math.abs(x - s.cx) <= 5 + pad && Math.abs(z - s.cz) <= 5 + pad);
  };

  // Paint a 1-wide yellow brick path along an L-shaped route, stopping at any
  // settlement wall. Over a pond the bricks form a little bridge at water level.
  World.prototype.layRoad = function (x0, z0, x1, z1, sites) {
    let x = x0, z = z0;
    const stepX = Math.sign(x1 - x0), stepZ = Math.sign(z1 - z0);
    const pts = [];
    while (x !== x1) { pts.push([x, z]); x += stepX; }
    while (z !== z1) { pts.push([x, z]); z += stepZ; }
    pts.push([x1, z1]);
    pts.forEach(([rx, rz]) => {
      if (rx < 1 || rz < 1 || rx >= C.WORLD - 1 || rz >= C.WORLD - 1) return;
      if (this.insideSite(rx, rz, sites)) return; // road meets the wall, not through it
      const y = (this._isWater && this._isWater(rx, rz)) ? C.WATER_LEVEL : this.surfaceY(rx, rz);
      this.blocks.set(World.key(rx, y, rz), "yellow_brick");
    });
  };

  // One settlement: a paved, walled keep with tall torch-topped corner spires
  // (so it's visible for miles) and a house in the middle holding the villager.
  World.prototype.buildQuestSettlement = function (cx, cz, level, num) {
    const R = 5;
    const floorY = this.surfaceY(cx, cz);
    const wallTop = floorY + 2 + level;            // taller walls for later towns
    const spireTop = C.MAX_Y - 1;                  // spires nearly touch the sky
    const wallMat = ["brown_brick", "brown_brick", "brick", "red_brick"][level - 1] || "brick";
    const crown = ["wood_red", "wood_blue", "wood_green", "wood_yellow"][level - 1] || "wood_red";

    // 1) Flatten + pave the plaza (fancier paving in the later settlements).
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const x = cx + dx, z = cz + dz;
        if (x < 1 || z < 1 || x >= C.WORLD - 1 || z >= C.WORLD - 1) continue;
        for (let y = floorY + 1; y <= C.MAX_Y + 3; y++) this.blocks.delete(World.key(x, y, z));
        this.fillColumn(x, z, Math.max(0, floorY - 1), floorY - 1, "dirt");
        const floorMat = level >= 3 ? (((dx + dz) & 1) ? "red_brick" : "brick") : "planks";
        this.blocks.set(World.key(x, floorY, z), floorMat);
      }
    }

    // 2) Perimeter wall with windows; a gateway on the -z (spawn-facing) side.
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 1 || z < 1 || x >= C.WORLD - 1 || z >= C.WORLD - 1) continue;
        if (dz === -R && Math.abs(dx) <= 1) continue;          // open gateway
        this.fillColumn(x, z, floorY + 1, wallTop, wallMat);
        if ((Math.abs(dx) + Math.abs(dz)) % 2 === 0) this.blocks.set(World.key(x, floorY + 2, z), "glass");
        // Later settlements get torch-topped battlements on their corners.
        if (level >= 2 && Math.abs(dx) === R && Math.abs(dz) === R) {
          this.blocks.set(World.key(x, wallTop + 1, z), "torch");
        }
      }
    }

    // 3) Four tall corner spires, each crowned with a glowing beacon torch.
    [[-R, -R], [R, -R], [-R, R], [R, R]].forEach(([dx, dz]) => {
      const x = cx + dx, z = cz + dz;
      if (x < 1 || z < 1 || x >= C.WORLD - 1 || z >= C.WORLD - 1) return;
      this.fillColumn(x, z, floorY + 1, spireTop - 1, "brick");
      this.blocks.set(World.key(x, spireTop, z), crown);
      if (spireTop + 1 <= C.MAX_Y) this.blocks.set(World.key(x, spireTop + 1, z), "torch");
    });

    // 4) The house in the middle, with the door / contents for this stage.
    this.buildQuestHouse(cx, cz, floorY, level, num);
  };

  // A little house in the centre of a settlement. House 1 has a plain door;
  // houses 2-4 are locked and need the matching key. House 3 hides the Nether
  // portal; house 4 holds the credits plaque.
  World.prototype.buildQuestHouse = function (cx, cz, floorY, level, num) {
    const hr = level >= 3 ? 3 : 2;                  // bigger houses later on
    const wall = num >= 3 ? "brick" : "brown_brick";
    const roof = num >= 3 ? "red_brick" : "planks";
    const top = floorY + 3;                         // walls are 3 blocks tall

    for (let dx = -hr; dx <= hr; dx++) {
      for (let dz = -hr; dz <= hr; dz++) {
        const x = cx + dx, z = cz + dz;
        // Seal the whole footprint's floor so you can't tunnel up into the house.
        this.markProtected(x, floorY, z);
        const edge = Math.max(Math.abs(dx), Math.abs(dz)) === hr;
        if (!edge) continue;
        if (dz === -hr && dx === 0) {
          // The doorway: a door at foot height, clear space above, a lintel up top.
          const doorId = num === 1 ? "door" : ("locked_door_" + num);
          this.blocks.set(World.key(x, floorY + 1, z), doorId);
          this.blocks.set(World.key(x, floorY + 3, z), wall);   // lintel (foot+2 stays open)
          this.markProtected(x, floorY + 1, z);                 // the (locked) door
          this.markProtected(x, floorY + 3, z);                 // the lintel above it
        } else {
          this.fillColumn(x, z, floorY + 1, top, wall);
          if ((Math.abs(dx) + Math.abs(dz)) % 2 === 0) this.blocks.set(World.key(x, floorY + 2, z), "glass");
          for (let y = floorY + 1; y <= top; y++) this.markProtected(x, y, z); // walls + windows
        }
      }
    }
    // Flat roof.
    for (let dx = -hr; dx <= hr; dx++) {
      for (let dz = -hr; dz <= hr; dz++) {
        this.blocks.set(World.key(cx + dx, floorY + 4, cz + dz), roof);
        this.markProtected(cx + dx, floorY + 4, cz + dz);
      }
    }
    // A torch inside so it isn't pitch dark.
    this.blocks.set(World.key(cx + hr - 1, floorY + 3, cz + hr - 1), "torch");

    // House 3 hides the Nether portal at the back; remember the safe cell the
    // player returns to when they come back out of the Nether.
    if (num === 3) {
      this.buildPortal(cx, floorY + 1, cz + hr - 1);
      this.questPortalExit = { x: cx + 0.5, y: floorY + 1, z: cz + 0.5 };
    }
    // House 4 mounts the "Hall of Fame" credits plaque on the back wall.
    if (num === 4) {
      this.blocks.set(World.key(cx, floorY + 2, cz + hr), "credits_block");
    }

    // The villager living here (none in house 4 — that one holds the credits).
    if (num <= 3) {
      const v = makeVillager();
      v.position.set(cx + 0.5, floorY + 1, cz + 0.5);
      v.userData.home = { x: cx + 0.5, z: cz + 0.5 };
      v.userData.roam = hr - 1.2;                 // amble inside the house only
      v.userData.dir = 0;
      v.userData.timer = 1 + num;
      v.userData.moving = false;
      v.userData.house = num;
      // The trade that advances the quest (a key; the third costs netherite).
      if (num === 1) v.userData.quest = { gives: "key2" };
      else if (num === 2) v.userData.quest = { gives: "key3" };
      else if (num === 3) v.userData.quest = { gives: "key4", cost: { id: "netherite", count: 1 } };
      this.questVillagers.push(v);
      this.animals.push(v);
    }
  };

  // A 1-wide, 2-tall purple portal framed in obsidian, centred on (x,z) with its
  // base at y. Used for the overworld portal and the Nether return portal.
  World.prototype.buildPortal = function (x, y, z) {
    const O = "obsidian";
    this.blocks.set(World.key(x, y - 1, z), O);     // sill
    this.blocks.set(World.key(x, y + 2, z), O);     // lintel
    for (let dy = 0; dy < 2; dy++) {
      this.blocks.set(World.key(x - 1, y + dy, z), O);
      this.blocks.set(World.key(x + 1, y + dy, z), O);
      this.blocks.set(World.key(x, y + dy, z), "nether_portal");
    }
    return { x: x, y: y, z: z };
  };

  // ================================================================
  //  The Nether: a fiery cavern of netherrack, lava, ghasts & netherite.
  // ================================================================
  World.prototype.generateNether = function () {
    this.isNether = true;
    this.fireballs = [];
    const SZ = C.WORLD, FLOOR = 2, CEIL = 14;

    for (let x = 0; x < SZ; x++) {
      for (let z = 0; z < SZ; z++) {
        for (let y = 0; y <= FLOOR; y++) this.blocks.set(World.key(x, y, z), "netherrack");
        this.blocks.set(World.key(x, CEIL, z), "netherrack");
        if (Game.hash(this.seed ^ 0xce11, x, 0, z) < 0.18) this.blocks.set(World.key(x, CEIL - 1, z), "netherrack");
        if (x === 0 || z === 0 || x === SZ - 1 || z === SZ - 1) {
          for (let y = FLOOR + 1; y < CEIL; y++) this.blocks.set(World.key(x, y, z), "netherrack");
        }
      }
    }

    // Netherite veins, lava pools, glowstone lights and a few netherrack pillars.
    for (let x = 2; x < SZ - 2; x++) {
      for (let z = 2; z < SZ - 2; z++) {
        if (Game.hash(this.seed ^ 0x9e7, x, FLOOR, z) < 0.07) this.blocks.set(World.key(x, FLOOR, z), "netherite_ore");
        if (Game.hash(this.seed ^ 0x9e8, x, FLOOR - 1, z) < 0.08) this.blocks.set(World.key(x, FLOOR - 1, z), "netherite_ore");
        if (Game.hash(this.seed ^ 0x47e, x, 1, z) < 0.03) this.blocks.set(World.key(x, FLOOR, z), "lava");
        if (Game.hash(this.seed ^ 0x6105, x, 0, z) < 0.025) this.blocks.set(World.key(x, CEIL - 1, z), "glowstone");
        if (Game.hash(this.seed ^ 0xb09, x, 0, z) < 0.02) {
          const h = 1 + Math.floor(Game.hash(this.seed ^ 0xb10, x, 0, z) * 5);
          for (let y = FLOOR + 1; y <= FLOOR + h; y++) this.blocks.set(World.key(x, y, z), "netherrack");
          if (Game.hash(this.seed ^ 0xb11, x, 0, z) < 0.5) this.blocks.set(World.key(x, FLOOR + 1, z), "netherite_ore");
        }
      }
    }

    // A return portal in a cleared corner; the player spawns just beside it.
    const px = 6, pz = 6;
    for (let x = px - 2; x <= px + 2; x++) {
      for (let z = pz - 2; z <= pz + 2; z++) {
        for (let y = FLOOR + 1; y <= FLOOR + 3; y++) this.blocks.delete(World.key(x, y, z));
        this.blocks.set(World.key(x, FLOOR, z), "netherrack"); // tidy floor (no lava at spawn)
      }
    }
    this.buildPortal(px, FLOOR + 1, pz);
    this.spawn = { x: px + 0.5, y: FLOOR + 1, z: pz + 2 + 0.5 };

    // Floating ghasts that drift overhead and spit fire.
    const rng = Game.mulberry32(this.seed ^ 0x6ace);
    for (let i = 0; i < 4; i++) {
      const g = makeGhast();
      const gx = 12 + Math.floor(rng() * (SZ - 24));
      const gz = 12 + Math.floor(rng() * (SZ - 24));
      const gy = FLOOR + 5 + rng() * 3;
      g.position.set(gx + 0.5, gy, gz + 0.5);
      g.userData.baseY = gy;
      g.userData.dir = rng() * Math.PI * 2;
      g.userData.t = rng() * Math.PI * 2;
      g.userData.timer = 1 + rng() * 3;
      g.userData.fireTimer = 2 + rng() * 3;
      this.animals.push(g);
    }
  };

  World.prototype.spawnAnimals = function (count) {
    const rng = Game.mulberry32(this.seed ^ 0xa11ce);

    // Ground animals wander the surface.
    for (let i = 0; i < count; i++) {
      const kind = GROUND_KINDS[Math.floor(rng() * GROUND_KINDS.length)];
      const a = makeAnimal(kind);
      const x = 4 + Math.floor(rng() * (C.WORLD - 8));
      const z = 4 + Math.floor(rng() * (C.WORLD - 8));
      a.position.set(x + 0.5, this.surfaceY(x, z) + 1, z + 0.5);
      a.userData.dir = rng() * Math.PI * 2;
      a.userData.timer = rng() * 3;
      a.userData.hop = 0;
      // Added to the scene later (see startWorld), once one exists.
      this.animals.push(a);
    }

    // Monkeys swing in a few of the trees (so forests are livelier than deserts).
    if (this.trees.length) {
      const want = 1 + Math.floor(rng() * (this.biome === "desert" ? 1 : 3));
      for (let i = 0; i < Math.min(want, this.trees.length); i++) {
        const tree = this.trees[Math.floor(rng() * this.trees.length)];
        const side = rng() < 0.5 ? 1 : -1;
        const m = makeMonkey();
        const home = { x: tree.x + 0.5 + side * 1.4, y: tree.top - 0.3, z: tree.z + 0.5,
          ry: side > 0 ? -Math.PI / 2 : Math.PI / 2 };
        m.position.set(home.x, home.y, home.z);
        m.rotation.y = home.ry;
        m.userData.home = home;
        m.userData.t = rng() * Math.PI * 2;
        m.userData.swingSpeed = 1.2 + rng() * 0.8;
        this.animals.push(m);
      }
    }
  };

  World.prototype.updateAnimals = function (dt) {
    for (const a of this.animals) {
      if (Game.S && Game.S.riding === a) continue; // the rider drives this one
      if (a.userData.kind === "monkey") { this.updateMonkey(a, dt); continue; }
      if (a.userData.kind === "villager") { this.updateVillager(a, dt); continue; }
      if (a.userData.kind === "ghast") continue; // ghasts are driven by updateNether

      // Ground animals just walk around on the surface — no hopping/floating.
      a.userData.timer -= dt;
      if (a.userData.timer <= 0) {
        a.userData.timer = 1.5 + Math.random() * 3;
        a.userData.dir = Math.random() * Math.PI * 2;
      }
      let speed = 0.7;
      if (a.userData.hop > 0) { a.userData.hop -= dt; speed = 1.9; } // spooked: trot off
      const nx = a.position.x + Math.cos(a.userData.dir) * speed * dt;
      const nz = a.position.z + Math.sin(a.userData.dir) * speed * dt;
      // stay inside the world — and inside any fence (a solid block stops them).
      if (this.canStand(nx, nz, a.position.y)) {
        a.position.x = nx; a.position.z = nz;
      } else {
        a.userData.dir += Math.PI; // turn around at the border / fence
      }
      const sy = this.surfaceY(Math.floor(a.position.x), Math.floor(a.position.z)) + 1;
      a.position.y += (sy - a.position.y) * Math.min(1, dt * 8);
      a.rotation.y = -a.userData.dir + Math.PI / 2;
    }
  };

  // Villagers mostly stand around their settlement, only occasionally taking a
  // slow, short stroll — and never wandering past their roam radius from home.
  World.prototype.updateVillager = function (a, dt) {
    const u = a.userData;
    u.timer -= dt;
    if (u.timer <= 0) {
      u.timer = 3 + Math.random() * 5;     // long pauses between strolls
      u.dir = Math.random() * Math.PI * 2;
      u.moving = Math.random() < 0.4;      // and usually they just stay put
    }
    if (u.moving) {
      const speed = 0.4;                   // a gentle amble
      const nx = a.position.x + Math.cos(u.dir) * speed * dt;
      const nz = a.position.z + Math.sin(u.dir) * speed * dt;
      const dx = nx - u.home.x, dz = nz - u.home.z;
      if (dx * dx + dz * dz <= u.roam * u.roam && this.canStand(nx, nz, a.position.y)) {
        a.position.x = nx; a.position.z = nz;
        a.rotation.y = -u.dir + Math.PI / 2;
      } else {
        u.dir += Math.PI; u.moving = false; // turn back toward the settlement
      }
    }
    const sy = this.surfaceY(Math.floor(a.position.x), Math.floor(a.position.z)) + 1;
    a.position.y += (sy - a.position.y) * Math.min(1, dt * 8);
  };

  // Drive the Nether: float the ghasts, let them fire, and fly the fireballs.
  // Each fireball that reaches the player costs them two hearts. Called from the
  // main loop with the live player while you're in the Nether.
  World.prototype.updateNether = function (dt, player) {
    const eye = player.eyePosition();
    const FLOOR = 2, CEIL = 14;

    for (const g of this.animals) {
      if (g.userData.kind !== "ghast") continue;
      const u = g.userData;
      // Bob up and down, drift slowly, turning every so often.
      u.t += dt;
      u.timer -= dt;
      if (u.timer <= 0) { u.timer = 2 + Math.random() * 3; u.dir = Math.random() * Math.PI * 2; }
      const speed = 0.7;
      const nx = g.position.x + Math.cos(u.dir) * speed * dt;
      const nz = g.position.z + Math.sin(u.dir) * speed * dt;
      if (nx > 3 && nx < C.WORLD - 3) g.position.x = nx; else u.dir = Math.PI - u.dir;
      if (nz > 3 && nz < C.WORLD - 3) g.position.z = nz; else u.dir = -u.dir;
      g.position.y = u.baseY + Math.sin(u.t * 0.8) * 0.6;
      g.position.y = Math.max(FLOOR + 3.5, Math.min(CEIL - 1.5, g.position.y));
      // Face roughly toward the player.
      g.rotation.y = Math.atan2(eye.x - g.position.x, eye.z - g.position.z);

      // Fire at random intervals when the player is within range.
      u.fireTimer -= dt;
      if (u.fireTimer <= 0) {
        u.fireTimer = 2.5 + Math.random() * 3;
        const dx = eye.x - g.position.x, dy = eye.y - g.position.y, dz = eye.z - g.position.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 22 && dist > 1.5) this.spawnFireball(g.position, { x: dx / dist, y: dy / dist, z: dz / dist });
      }
    }

    this.updateFireballs(dt, player);
  };

  World.prototype.spawnFireball = function (from, dir) {
    const SPEED = 9;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.3, 0.3),
      new THREE.MeshLambertMaterial({ color: 0xff7a1a, emissive: 0xff4500 })
    );
    mesh.position.set(from.x, from.y, from.z);
    if (this.scene) this.scene.add(mesh);
    this.fireballs.push({ mesh: mesh, vel: { x: dir.x * SPEED, y: dir.y * SPEED, z: dir.z * SPEED }, life: 4 });
  };

  World.prototype.updateFireballs = function (dt, player) {
    if (!this.fireballs) return;
    const eye = player.eyePosition();
    const remove = (fb) => { if (this.scene) this.scene.remove(fb.mesh); if (fb.mesh.geometry) fb.mesh.geometry.dispose(); };
    this.fireballs = this.fireballs.filter((fb) => {
      const m = fb.mesh;
      m.position.x += fb.vel.x * dt;
      m.position.y += fb.vel.y * dt;
      m.position.z += fb.vel.z * dt;
      m.rotation.x += dt * 6; m.rotation.y += dt * 6;
      fb.life -= dt;
      // Hit the player? Two hearts of damage.
      const dx = m.position.x - eye.x, dy = m.position.y - eye.y, dz = m.position.z - eye.z;
      if (dx * dx + dy * dy + dz * dz < 0.8 * 0.8) {
        player.damage(4, "were scorched by a ghast's fireball");
        if (Game.toast) Game.toast("🔥 A ghast's fireball hit you! (-2 ❤️)");
        remove(fb); return false;
      }
      // Hit a block or fizzle out.
      if (this.solidAt(Math.floor(m.position.x), Math.floor(m.position.y), Math.floor(m.position.z)) || fb.life <= 0) {
        remove(fb); return false;
      }
      return true;
    });
  };

  // Monkeys hang in place and sway back and forth like they're swinging.
  World.prototype.updateMonkey = function (a, dt) {
    a.userData.t += dt;
    const home = a.userData.home;
    const swing = Math.sin(a.userData.t * a.userData.swingSpeed);
    a.rotation.z = swing * 0.5;                    // pendulum sway
    a.position.x = home.x + swing * 0.22;          // travel a little with the swing
    a.position.z = home.z;
    a.position.y = home.y - Math.abs(Math.cos(a.userData.t * a.userData.swingSpeed)) * 0.08;
  };

  // Expose the per-type cube geometry so the held-item viewmodel can reuse it.
  World.geometry = blockGeometry;

  Game.World = World;

})(window.Game);
