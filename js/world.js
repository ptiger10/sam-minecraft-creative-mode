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
  // chunk's edge), instead of rebuilding the entire world every time. Sized so
  // the big 96-block worlds stay at a modest 6x6 grid of chunks.
  const CHUNK = 16;
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
    return speckledGeometry(id, def.base, def.all, 0.3);
  }

  // Build a cube that is mostly baseColor with little square specks of
  // speckColor. Because the cube is subdivided into a coarse grid and each grid
  // cell shares one flat colour, every speck reads as a crisp little square —
  // keeping with the game's blocky look. Deterministic per id so it's stable.
  function speckledGeometry(id, baseColor, speckColor, density) {
    const seg = 5;
    const g = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg);
    const pos = g.attributes.position;
    const base = new THREE.Color(baseColor);
    const speck = new THREE.Color(speckColor);
    let salt = 0;
    for (let i = 0; i < id.length; i++) salt = (salt * 31 + id.charCodeAt(i)) | 0;
    const colors = [];
    for (let i = 0; i < pos.count; i++) {
      // Snap the vertex to its cell on the cube so a whole speck shares a colour.
      const gx = Math.round((pos.getX(i) + 0.5) * seg);
      const gy = Math.round((pos.getY(i) + 0.5) * seg);
      const gz = Math.round((pos.getZ(i) + 0.5) * seg);
      const c = Game.hash(salt ^ 0x5eed, gx, gy, gz) < density ? speck : base;
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }

  // Obsidian: a pitch-black block flecked with small purple squares.
  function obsidianGeometry() {
    const def = Game.BlockDefs.obsidian;
    return speckledGeometry("obsidian", def.all, def.speckle, 0.22);
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
  function stairsGeometry(id) {
    const def = Game.BlockDefs[id] || Game.BlockDefs.stairs;
    const lower = new THREE.Color(def.side), upper = new THREE.Color(def.top);
    return mergeColoredBoxes([
      { g: Box(1, 0.5, 1), x: 0, y: -0.25, z: 0, c: lower },   // bottom step (front)
      { g: Box(1, 0.5, 0.5), x: 0, y: 0.25, z: -0.25, c: upper } // upper step (back)
    ]);
  }

  // Masonry bricks rendered with a running-bond brick pattern: courses of bricks
  // separated by darker mortar joints, the vertical joints offset every other
  // row. The cube is subdivided and coloured per-triangle (non-indexed) so the
  // mortar reads as crisp little lines rather than a smear.
  function brickGeometry(id) {
    const def = Game.BlockDefs[id];
    const seg = 8;                              // 8x8 cells per face
    const g = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg).toNonIndexed();
    const pos = g.attributes.position, nor = g.attributes.normal;
    const brick = new THREE.Color(def.all);
    const mortar = new THREE.Color(Game.mix(def.all, 0x000000, 0.42)); // darker joints
    const colors = new Float32Array(pos.count * 3);
    const ROW = 4;      // a brick course is 4 cells tall  -> 2 courses per block
    const COL = 4;      // a brick is 4 cells wide         -> 2 bricks per course
    for (let t = 0; t < pos.count; t += 3) {
      // Triangle centroid, mapped to face-local (u, v) in 0..1.
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) { cx += pos.getX(t + k); cy += pos.getY(t + k); cz += pos.getZ(t + k); }
      cx = cx / 3 + 0.5; cy = cy / 3 + 0.5; cz = cz / 3 + 0.5;
      const nx = nor.getX(t), ny = nor.getY(t);
      let u, v;
      if (Math.abs(ny) > 0.5) { u = cx; v = cz; }        // top / bottom
      else if (Math.abs(nx) > 0.5) { u = cz; v = cy; }   // +/-x sides
      else { u = cx; v = cy; }                            // +/-z sides
      const vc = Math.floor(v * seg + 1e-4);             // vertical cell 0..7
      const course = Math.floor(vc / ROW);               // which brick course
      const off = (course % 2) * (COL / 2);              // running-bond offset
      const uc = (Math.floor(u * seg + 1e-4) + off) % COL;
      const isMortar = (vc % ROW === 0) || (uc === 0);   // bottom joint + left joint
      const c = isMortar ? mortar : brick;
      for (let k = 0; k < 3; k++) { colors[(t + k) * 3] = c.r; colors[(t + k) * 3 + 1] = c.g; colors[(t + k) * 3 + 2] = c.b; }
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
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

  // The End portal (in the 4th house): a dark, near-black cross flecked with a
  // couple of pale "stars", so it reads as a doorway into the starry void.
  function endPortalGeometry() {
    const a = new THREE.Color(0x151538), b = new THREE.Color(0x0a0a1e), star = new THREE.Color(0x9fe8ff);
    return mergeColoredBoxes([
      { g: Box(0.86, 1.0, 0.2), x: 0, y: 0, z: 0, c: a },
      { g: Box(0.2, 1.0, 0.86), x: 0, y: 0, z: 0, c: b },
      { g: Box(0.12, 0.12, 0.24), x: 0.18, y: 0.28, z: 0, c: star },
      { g: Box(0.12, 0.12, 0.24), x: -0.16, y: -0.22, z: 0, c: star },
      { g: Box(0.24, 0.12, 0.12), x: 0, y: 0.06, z: 0.18, c: star }
    ]);
  }

  // An End Portal frame block: pale-green-capped dark stone with an eye socket
  // showing on its faces. Empty = a dark recessed socket; filled = a glowing
  // Eye of Ender bulging from the top and both broad faces of the arch.
  function endFrameGeometry(withEye) {
    const def = Game.BlockDefs.end_frame;
    const body = new THREE.Color(def.side);
    const cap = new THREE.Color(def.top);
    const socket = new THREE.Color(0x10231c);          // dark empty recess
    const eyeC = new THREE.Color(0xbfffe8);            // pale glowing eye
    const pupil = new THREE.Color(0x1d4a3a);
    const parts = [
      { g: Box(1, 1, 1), x: 0, y: 0, z: 0, c: body },
      { g: Box(1.02, 0.18, 1.02), x: 0, y: 0.44, z: 0, c: cap },
      // The socket shows on the top and on both faces of the portal plane (±z).
      { g: Box(0.4, 0.06, 0.4), x: 0, y: 0.51, z: 0, c: socket },
      { g: Box(0.4, 0.4, 0.06), x: 0, y: 0.05, z: 0.5, c: socket },
      { g: Box(0.4, 0.4, 0.06), x: 0, y: 0.05, z: -0.5, c: socket }
    ];
    if (withEye) {
      parts.push(
        { g: Box(0.3, 0.14, 0.3), x: 0, y: 0.55, z: 0, c: eyeC },
        { g: Box(0.3, 0.3, 0.12), x: 0, y: 0.05, z: 0.53, c: eyeC },
        { g: Box(0.3, 0.3, 0.12), x: 0, y: 0.05, z: -0.53, c: eyeC },
        { g: Box(0.12, 0.12, 0.06), x: 0, y: 0.05, z: 0.61, c: pupil },
        { g: Box(0.12, 0.12, 0.06), x: 0, y: 0.05, z: -0.61, c: pupil }
      );
    }
    return mergeColoredBoxes(parts);
  }

  // The crafted Exit Portal: a bright magenta crystal cross you step through to
  // win — clearly different from the dark entry portal and the purple Nether one.
  function exitPortalGeometry() {
    const a = new THREE.Color(Game.BlockDefs.exit_portal.top);
    const b = new THREE.Color(Game.BlockDefs.exit_portal.all);
    return mergeColoredBoxes([
      { g: Box(0.86, 1.0, 0.2), x: 0, y: 0, z: 0, c: a },
      { g: Box(0.2, 1.0, 0.86), x: 0, y: 0, z: 0, c: b }
    ]);
  }

  // An End Crystal: a glowing magenta gem — a slim box turned 45° so it reads as
  // a crystal, with a brighter inner core and a small dark base.
  function endCrystalGeometry() {
    const outer = new THREE.Color(Game.BlockDefs.end_crystal.all);
    const core = new THREE.Color(0xf3d6ff);
    const base = new THREE.Color(0x3a2350);
    const gem = Box(0.5, 0.86, 0.5); gem.rotateY(Math.PI / 4);
    const spine = Box(0.22, 1.0, 0.22); spine.rotateY(Math.PI / 4);
    return mergeColoredBoxes([
      { g: gem, x: 0, y: 0.05, z: 0, c: outer },
      { g: spine, x: 0, y: 0.05, z: 0, c: core },
      { g: Box(0.66, 0.14, 0.66), x: 0, y: -0.44, z: 0, c: base }
    ]);
  }

  function blockGeometry(id) {
    if (geomCache[id]) return geomCache[id];
    if (id === "nether_portal") return (geomCache[id] = netherPortalGeometry());
    if (id === "end_portal") return (geomCache[id] = endPortalGeometry());
    if (id === "exit_portal") return (geomCache[id] = exitPortalGeometry());
    if (id === "end_crystal") return (geomCache[id] = endCrystalGeometry());
    if (id === "end_frame") return (geomCache[id] = endFrameGeometry(false));
    if (id === "end_frame_eye") return (geomCache[id] = endFrameGeometry(true));
    if (id === "credits_block") return (geomCache[id] = creditsBlockGeometry());
    if (id === "obsidian") return (geomCache[id] = obsidianGeometry());
    if (Game.LOCKED && Game.LOCKED[id]) return (geomCache[id] = lockedDoorGeometry(Game.LOCKED[id]));
    if (id === "stairs" || id === "brick_stairs") return (geomCache[id] = stairsGeometry(id));
    if (Game.isBrickBlock && Game.isBrickBlock(id)) return (geomCache[id] = brickGeometry(id));
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
  function World(scene, seed, biome, legacy) {
    this.scene = scene;
    this.seed = seed >>> 0;
    this.biome = biome; // the biome around the spawn: "forest" | "desert"
    // Worlds saved before the big multi-biome update were 40 blocks wide with a
    // single biome throughout. They regenerate through the exact old code paths
    // (see biomeAt) so nothing a player built or explored moves an inch.
    this.legacy = !!legacy;
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
    const height = this.legacy ? Game.makeHeight(this.seed) : Game.makeOpenHeight(this.seed);
    this.setupBiomes();
    this.planQuestSites();
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
    // Stamp a few deliberate watering holes into the heightmap so every world
    // gets some surface water (an oasis or two even in the dry desert).
    this._holes = new Set();
    this.stampWateringHoles(H, WATER);
    this._H = H; // pure terrain heights — surfaceY would count trees and builds

    // A column floods if it dips below the water line (kept away from spawn so
    // you never start in a puddle). Natural low-terrain ponds skip the desert,
    // but a carved watering hole floods in any biome.
    const isWater = (x, z) => {
      if (x < 0 || x >= C.WORLD || z < 0 || z >= C.WORLD) return false;
      if (nearSpawn(x, z)) return false;
      if (this._holes.has(x + "," + z)) return true;
      return this.biomeAt(x, z) !== "desert" && H[x][z] < WATER;
    };
    this._isWater = isWater;

    for (let x = 0; x < C.WORLD; x++) {
      for (let z = 0; z < C.WORLD; z++) {
        const h = H[x][z];
        const water = isWater(x, z);
        const biome = this.biomeAt(x, z);
        const desert = biome === "desert";
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === h) {
            if (water) id = Game.hash(this.seed ^ 0xc1a7, x, 0, z) < 0.5 ? "clay" : "sand"; // pond bed
            else if (desert) id = this.desertSurface(x, z);
            else if (biome === "roofed") id = "dark_grass";
            else if (biome === "snow") id = "snow";
            else id = "grass";
          } else if (y >= h - 2) {
            id = desert ? "sand" : "dirt";
          } else {
            id = this.pickStone(x, y, z);
          }
          this.blocks.set(World.key(x, y, z), id);
        }
        // Fill the pond with water up to the water line. Snowy ponds freeze
        // over — the top layer is ice you can walk right across.
        if (water) {
          for (let y = h + 1; y <= WATER; y++) this.blocks.set(World.key(x, y, z), "water");
          if (biome === "snow" && h < WATER) this.blocks.set(World.key(x, WATER, z), "ice");
        }
        // Vegetation sits on top of dry land only.
        if (!water) this.maybeVegetation(x, z, h, biome);
      }
    }

    // Sandy shore: any land block right beside the water becomes sand — but
    // only in the sunny biomes. Snowy ponds stay ringed in snow and the roofed
    // forest keeps its dark floor; neither grows sugar cane.
    for (let x = 0; x < C.WORLD; x++) {
      for (let z = 0; z < C.WORLD; z++) {
        if (isWater(x, z)) continue;
        const b = this.biomeAt(x, z);
        if (b === "snow" || b === "roofed") continue;
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

    // Lava: pools tucked underground (dig down to find them) plus the odd
    // glowing lake right on the surface.
    this.scatterLavaPools();
    this.scatterSurfaceLava();

    // The big open worlds hold more life (and more night-time danger) so the
    // extra ground never feels empty. Legacy worlds keep their original counts.
    this.spawnAnimals(this.legacy ? (this.biome === "desert" ? 3 : 4) : 12);
    // Four settlements joined by a yellow brick road, with the quest villagers.
    this.buildQuestWorld();

    // The woodland mansion, deep in its guaranteed roofed-forest grove.
    if (!this.legacy) this.buildWoodlandMansion();

    // Fluffy clouds drifting high above everything else.
    this.scatterClouds();

    // Night monsters: skeleton archers and shambling zombies. Hidden by day.
    this.arrows = [];
    this.spawnSkeletons(this.legacy ? 2 : 5);
    this.spawnZombies(this.legacy ? 3 : 7);
  };

  // ---- Biomes ----------------------------------------------------
  // New worlds are a patchwork of biomes painted by two slow noise fields
  // (temperature picks snow / desert, moisture picks roofed forest), so walking
  // in any direction eventually crosses into somewhere that looks different.
  World.prototype.setupBiomes = function () {
    if (this.legacy) return; // old worlds are one biome throughout
    const temp = Game.makeNoise(this.seed ^ 0x7e39a1, 23, 111);
    const moist = Game.makeNoise(this.seed ^ 0x30157e, 19, 222);
    const raw = (x, z) => {
      const t = temp(x, z);
      if (t < 0.33) return "snow";
      if (t > 0.70) return "desert";
      return moist(x, z) > 0.60 ? "roofed" : "forest";
    };
    this._rawBiome = raw;

    // Shift the whole biome map (deterministically) until the spawn clearing
    // sits in the biome the player picked on the title screen.
    const sc = Math.floor(C.WORLD / 2);
    const want = this.biome === "desert" ? "desert" : "forest";
    const samples = [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]];
    this._biomeOff = { x: 0, z: 0 };
    for (let k = 0; k < 600; k++) {
      const ox = Math.floor(Game.hash(this.seed ^ 0x0ff5e7, k, 0, 0) * 4096);
      const oz = Math.floor(Game.hash(this.seed ^ 0x0ff5e7, k, 1, 0) * 4096);
      if (samples.every(([dx, dz]) => raw(sc + dx + ox, sc + dz + oz) === want)) {
        this._biomeOff = { x: ox, z: oz };
        break;
      }
    }

    // One roofed-forest grove is guaranteed — the woodland mansion's home. It
    // takes one of the eight ring anchor spots (see ringSlots); the settlements
    // later take four spots at least two ring-steps away, so nothing collides.
    const slots = this.ringSlots();
    const gi = Math.floor(Game.hash(this.seed ^ 0x9a05e, 1, 2, 3) * 8);
    this._grove = { x: slots[gi].x, z: slots[gi].z, r: 15, slot: gi };
  };

  // Eight evenly spaced anchor spots on a ring around the spawn — the scaffold
  // the grove and the four settlements are scattered onto.
  World.prototype.ringSlots = function () {
    const sc = Math.floor(C.WORLD / 2), R = Math.round(C.WORLD * 0.28);
    const out = [];
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      out.push({ x: sc + Math.round(R * Math.cos(a)), z: sc + Math.round(R * Math.sin(a)) });
    }
    return out;
  };

  // Decide where the four settlements go, before terrain features are carved
  // (ponds and lava lakes keep clear of them). Legacy worlds keep their exact
  // old spots on the centre axes; new worlds scatter one settlement into each
  // quadrant of the map, so the yellow brick road becomes a proper journey.
  World.prototype.planQuestSites = function () {
    const sc = Math.floor(C.WORLD / 2);
    if (this.legacy) {
      this._sitePlan = [
        { cx: 9, cz: sc, level: 1 },
        { cx: sc, cz: 9, level: 2 },
        { cx: C.WORLD - 9, cz: sc, level: 3 },
        { cx: sc, cz: C.WORLD - 9, level: 4 }
      ];
      return;
    }
    const rng = Game.mulberry32(this.seed ^ 0x517e5);
    const cheb = (ax, az, bx, bz) => Math.max(Math.abs(ax - bx), Math.abs(az - bz));
    const clamp = (v) => Math.max(9, Math.min(C.WORLD - 10, v));
    // The grove owns one ring slot; the settlements take four of the five
    // slots that sit at least two ring-steps away — so the mansion always has
    // breathing room. One slot is skipped at random and the walk direction
    // flips at random, so every world's journey arcs differently.
    const slots = this.ringSlots();
    const gi = this._grove.slot;
    const avail = [2, 3, 4, 5, 6].map((o) => (gi + o) % 8);
    avail.splice(Math.floor(rng() * avail.length), 1);
    if (rng() < 0.5) avail.reverse();
    const plan = [];
    avail.forEach((si, i) => {
      const s = slots[si];
      let cx = clamp(s.x), cz = clamp(s.z);
      for (let t = 0; t < 20; t++) {                 // jitter, but stay spread out
        const tx = clamp(s.x + Math.floor(rng() * 7) - 3);
        const tz = clamp(s.z + Math.floor(rng() * 7) - 3);
        if (plan.some((p) => cheb(tx, tz, p.cx, p.cz) < 17)) continue;
        cx = tx; cz = tz;
        break;
      }
      plan.push({ cx: cx, cz: cz, level: i + 1 });
    });
    this._sitePlan = plan;
  };

  // Which biome does this column belong to?
  World.prototype.biomeAt = function (x, z) {
    if (this.legacy) return this.biome; // uniform, exactly like the old worlds
    const g = this._grove;
    if (g && Math.max(Math.abs(x - g.x), Math.abs(z - g.z)) <= g.r) return "roofed";
    return this._rawBiome(x + this._biomeOff.x, z + this._biomeOff.z);
  };

  // A few skeleton archers, hidden away by day. They wake and roam at night.
  World.prototype.spawnSkeletons = function (count) {
    const rng = Game.mulberry32(this.seed ^ 0x5ce1e7);
    for (let i = 0; i < count; i++) {
      const sk = makeSkeleton();
      const x = 5 + Math.floor(rng() * (C.WORLD - 10));
      const z = 5 + Math.floor(rng() * (C.WORLD - 10));
      sk.position.set(x + 0.5, this.surfaceY(x, z) + 1, z + 0.5);
      sk.visible = false;             // asleep until nightfall
      sk.userData.dir = rng() * Math.PI * 2;
      sk.userData.timer = rng() * 3;
      sk.userData.shootTimer = 1 + rng() * 3;
      this.animals.push(sk);
    }
  };

  // Three zombies that shamble around at night; hidden by day. They don't shoot
  // — they just hurt you if they bump into you.
  World.prototype.spawnZombies = function (count) {
    const rng = Game.mulberry32(this.seed ^ 0x20b1e5);
    for (let i = 0; i < count; i++) {
      const z0 = makeZombie();
      const x = 5 + Math.floor(rng() * (C.WORLD - 10));
      const z = 5 + Math.floor(rng() * (C.WORLD - 10));
      z0.position.set(x + 0.5, this.surfaceY(x, z) + 1, z + 0.5);
      z0.visible = false;             // asleep until nightfall
      z0.userData.dir = rng() * Math.PI * 2;
      z0.userData.timer = rng() * 3;
      z0.userData.hitCooldown = 0;    // brief pause between bites
      this.animals.push(z0);
    }
  };

  // Fluffy white clouds sit in a single layer high in the sky — puffy patches
  // with ragged gaps, far above the terrain, trees and settlement towers.
  World.prototype.scatterClouds = function () {
    const CLOUD_Y = C.MAX_Y + 3;   // clear of the tallest settlement mast
    const CELL = 6;                // size of each cloudy/clear sky patch
    for (let x = 1; x < C.WORLD - 1; x++) {
      for (let z = 1; z < C.WORLD - 1; z++) {
        const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
        if (Game.hash(this.seed ^ 0xc10d, gx, 0, gz) > 0.4) continue; // clear patch
        if (Game.hash(this.seed ^ 0xc10e, x, 0, z) < 0.22) continue;  // ragged gap
        this.blocks.set(World.key(x, CLOUD_Y, z), "cloud");
      }
    }
  };

  // Scatter small lava pools underground, well away from spawn, at a range of
  // depths so you meet them whether you dig shallow or deep. Each is a rounded
  // basin of lava with an air gap above, so digging down reveals a glowing pool
  // rather than a solid block.
  World.prototype.scatterLavaPools = function () {
    const cx = Math.floor(C.WORLD / 2), cz = Math.floor(C.WORLD / 2);
    for (let x = 4; x < C.WORLD - 4; x++) {
      for (let z = 4; z < C.WORLD - 4; z++) {
        if (Math.abs(x - cx) <= 4 && Math.abs(z - cz) <= 4) continue; // not under spawn
        // Lava lives mostly UNDERGROUND — twice as many buried pools as the
        // old worlds, waiting to be dug into.
        if (Game.hash(this.seed ^ 0x1a0a, x, 0, z) > 0.028) continue; // scattered centres
        let py = 2 + Math.floor(Game.hash(this.seed ^ 0x1a0b, x, 0, z) * 5); // depth 2..6
        // Depth measured from the TERRAIN, not surfaceY — a tree on this
        // column used to hoist the "underground" pool up into its canopy.
        const surf = (this._H && this._H[x]) ? this._H[x][z] : this.surfaceY(x, z);
        if (py > surf - 3) py = surf - 3;   // always keep it well underground
        if (py < 1) continue;
        this.carveLavaPool(x, py, z);
      }
    }
  };

  // A couple of glowing lava lakes right on the surface, kept away from spawn
  // and the settlements. Lava is solid, so you can walk up to the edge — and
  // pour a bucket of water on it to make obsidian.
  World.prototype.scatterSurfaceLava = function () {
    const sc = Math.floor(C.WORLD / 2);
    const siteCenters = this._sitePlan.map((s) => [s.cx, s.cz]);
    const cheb = (x, z, ox, oz) => Math.max(Math.abs(x - ox), Math.abs(z - oz));
    const rng = Game.mulberry32(this.seed ^ 0x1a0ace);
    const want = 2;    // just a couple visible up top — the rest hides below ground
    let made = 0, tries = 0;
    while (made < want && tries < 300) {
      tries++;
      const r = 1 + Math.floor(rng() * 2);              // radius 1..2 (small lakes)
      const x = 5 + Math.floor(rng() * (C.WORLD - 10));
      const z = 5 + Math.floor(rng() * (C.WORLD - 10));
      if (cheb(x, z, sc, sc) <= 6) continue;            // away from the spawn plaza
      if (siteCenters.some(([ox, oz]) => cheb(x, z, ox, oz) <= r + 6)) continue; // clear of towns
      if (this._grove && cheb(x, z, this._grove.x, this._grove.z) <= 14) continue; // off the mansion grounds
      if (this._holes && this._holes.has(x + "," + z)) continue; // not in a water hole
      this.carveSurfaceLavaLake(x, z, r);
      made++;
    }
  };

  World.prototype.carveSurfaceLavaLake = function (cx, cz, r) {
    // Use the pure TERRAIN height — surfaceY counts trees, which used to perch
    // whole lava lakes absurdly on top of a leaf canopy.
    const baseY = (this._H && this._H[cx]) ? this._H[cx][cz] : this.surfaceY(cx, cz);
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > r) continue;  // rounded blob
        const x = cx + dx, z = cz + dz;
        if (x < 1 || z < 1 || x >= C.WORLD - 1 || z >= C.WORLD - 1) continue;
        for (let y = baseY; y <= C.MAX_Y; y++) this.blocks.delete(World.key(x, y, z)); // clear plants/soil above
        this.blocks.set(World.key(x, baseY, z), "lava");
        // Solid stone underneath — never a tree canopy or thin air.
        const below = this.blocks.get(World.key(x, baseY - 1, z));
        if (!below || below === "wood" || below === "leaves" || below === "dark_wood" ||
            below === "dark_leaves" || below === "cactus" || below === "apple") {
          this.blocks.set(World.key(x, baseY - 1, z), "stone");
        }
      }
    }
  };

  World.prototype.carveLavaPool = function (cx, py, cz) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 3) continue; // rounded blob
        const x = cx + dx, z = cz + dz;
        if (x < 1 || z < 1 || x >= C.WORLD - 1 || z >= C.WORLD - 1) continue;
        this.blocks.set(World.key(x, py, z), "lava");
        this.blocks.delete(World.key(x, py + 1, z)); // air gap above the pool
        this.blocks.delete(World.key(x, py + 2, z));
        if (!this.occupied(x, py - 1, z)) this.blocks.set(World.key(x, py - 1, z), "stone");
      }
    }
  };

  // Desert surface is mostly sand, with the odd patch of coloured clay.
  World.prototype.desertSurface = function (x, z) {
    const r = Game.hash(this.seed ^ 0x7e44a, x, 0, z);
    if (r < 0.04) return "red_clay";
    if (r < 0.075) return "brown_clay";
    return "sand";
  };

  // Carve a handful of shallow, rounded basins into the heightmap. Each dips
  // below the water line so the normal pond-bed / shore / sugar-cane passes fill
  // it in. Holes are kept off the spawn plaza and clear of the settlements.
  World.prototype.stampWateringHoles = function (H, WATER) {
    const sc = Math.floor(C.WORLD / 2);
    const siteCenters = this._sitePlan.map((s) => [s.cx, s.cz]);
    const cheb = (x, z, ox, oz) => Math.max(Math.abs(x - ox), Math.abs(z - oz));
    const rng = Game.mulberry32(this.seed ^ 0x0a51de);
    const want = this.legacy ? 4 : 10;  // more ponds spread across the big map
    const cap = this.legacy ? 80 : 300; // legacy keeps its exact old try budget
    let made = 0, tries = 0;
    while (made < want && tries < cap) {
      tries++;
      const r = 2 + Math.floor(rng() * 2);              // radius 2..3
      const x = 5 + Math.floor(rng() * (C.WORLD - 10));
      const z = 5 + Math.floor(rng() * (C.WORLD - 10));
      if (cheb(x, z, sc, sc) <= 5) continue;            // off the spawn plaza
      if (siteCenters.some(([ox, oz]) => cheb(x, z, ox, oz) <= r + 6)) continue; // clear of towns
      if (this._grove && cheb(x, z, this._grove.x, this._grove.z) <= 14) continue; // off the mansion grounds
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const dist = Math.abs(dx) + Math.abs(dz);
          if (dist > r) continue;                        // rounded bowl
          const hx = x + dx, hz = z + dz;
          if (hx < 1 || hz < 1 || hx >= C.WORLD - 1 || hz >= C.WORLD - 1) continue;
          H[hx][hz] = Math.max(1, Math.min(H[hx][hz], WATER - 1 - (r - dist)));
          this._holes.add(hx + "," + hz);
        }
      }
      made++;
    }
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
    // Coal and iron are the workhorse ores, so they're common finds — more
    // than double their old rates. The precious ores keep their old rarity.
    if (r < 0.022) return "coal_ore";
    if (r < 0.040) return "iron_ore";
    if (r < 0.046) return "gold_ore";
    if (r < 0.052) return "redstone_ore";
    // Diamonds & emeralds are rare everywhere (so you can find some by digging
    // almost anywhere) and a bit richer down deep. Mine them with a pickaxe.
    if (r < (deep ? 0.062 : 0.055)) return "diamond_ore";
    if (r < (deep ? 0.067 : 0.058)) return "emerald_ore";
    return "stone";
  };

  // Trees, apple trees and cacti — deterministic from the seed, and different
  // in every biome. (Legacy worlds only ever pass "forest" or "desert", and
  // those branches keep their exact original maths.)
  World.prototype.maybeVegetation = function (x, z, h, biome) {
    // keep vegetation away from the very edges
    if (x < 2 || z < 2 || x >= C.WORLD - 2 || z >= C.WORLD - 2) return;
    // keep a clearing around the spawn point so you never start stuck in a tree
    const cx = Math.floor(C.WORLD / 2), cz = Math.floor(C.WORLD / 2);
    if (Math.abs(x - cx) <= 2 && Math.abs(z - cz) <= 2) return;
    const r = Game.hash(this.seed ^ 0x55aa, x, 0, z);

    if (biome === "desert") {
      // Deserts grow cacti and melons — no trees. (The original 40-block
      // worlds had a rare oasis apple tree; legacy keeps it so they
      // regenerate exactly as they were.)
      if (r < 0.05) this.placeCactus(x, h + 1, z);
      else if (r < 0.065) this.blocks.set(World.key(x, h + 1, z), "watermelon"); // melons in the sand
      else if (this.legacy && r > 0.985) this.placeTree(x, h + 1, z, true);
      return;
    }

    // Roofed forest: huge dark oaks packed so tight their canopies knit into a
    // shady roof. No melons down here — it's too dark.
    if (biome === "roofed") {
      if (r < 0.09) this.placeDarkTree(x, h + 1, z);
      return;
    }

    // Snowy hills: a bare, windswept snowfield — nothing grows up here. The
    // frozen ponds are the landmark, not trees.
    if (biome === "snow") return;

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

  // A dark oak for the roofed forest: a taller trunk under a broad, flat canopy
  // that merges with its neighbours into a near-solid leafy roof.
  World.prototype.placeDarkTree = function (x, y, z) {
    const trunk = 5 + Math.floor(Game.hash(this.seed ^ 0xda2c, x, 9, z) * 2); // 5..6
    for (let i = 0; i < trunk; i++) this.blocks.set(World.key(x, y + i, z), "dark_wood");
    const top = y + trunk;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = -1; dy <= 0; dy++) {
          const reach = dy === 0 ? 3 : 4;   // wider skirt just under the top layer
          if (Math.abs(dx) + Math.abs(dz) > reach) continue;
          const lx = x + dx, ly = top + dy, lz = z + dz;
          if (this.occupied(lx, ly, lz)) continue; // don't overwrite the trunk
          this.blocks.set(World.key(lx, ly, lz), "dark_leaves");
        }
      }
    }
    if (!this.occupied(x, top + 1, z)) this.blocks.set(World.key(x, top + 1, z), "dark_leaves");
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

  // A piglin: a stubby pink-brown brute with a flat golden snout and little
  // tusks. It wanders the Nether floor; trade it a gold ingot for treasure.
  function makePiglin() {
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const skin = 0xd98f86, snout = 0xcaa04a, cloth = 0x6f4a2c;
    // Legs
    [-0.16, 0.16].forEach((x) => {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.44, 0.24), mat(cloth));
      l.position.set(x, 0.22, 0); group.add(l);
    });
    // Body
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.36), mat(skin));
    body.position.set(0, 0.74, 0); group.add(body);
    // Arms
    [-0.4, 0.4].forEach((x) => {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.54, 0.2), mat(skin));
      a.position.set(x, 0.72, 0); group.add(a);
    });
    // Head
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.5, 0.5), mat(skin));
    head.position.set(0, 1.28, 0); group.add(head);
    // Golden snout
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.14), mat(snout));
    nose.position.set(0, 1.2, 0.3); group.add(nose);
    // Eyes (white) + tusks
    [-0.14, 0.14].forEach((x) => {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.05), mat(0xffffff));
      e.position.set(x, 1.34, 0.26); group.add(e);
      const tusk = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.06), mat(0xf3efe2));
      tusk.position.set(x, 1.06, 0.28); group.add(tusk);
    });
    // Pointy ears
    [-0.32, 0.32].forEach((x) => {
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.1), mat(skin));
      ear.position.set(x, 1.38, 0); group.add(ear);
    });
    group.userData.kind = "piglin";
    return group;
  }
  World.makePiglin = makePiglin;

  // The Wither: a floating charcoal-boned menace with THREE skulls and NO legs.
  // A ribbed spine hangs beneath a wide shoulder bar that carries the three
  // heads; it drifts above the Nether floor near the fortress and flings wither
  // skulls in random directions. The group is centred on the shoulder bar.
  function makeWither() {
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const bone = 0x33333a, boneDark = 0x27272c, skull = 0x1b1b20;
    const eyeMat = () => new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x777777 });
    // Wide shoulder bar the three heads sit on.
    const yoke = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.18, 0.22), mat(boneDark));
    yoke.position.set(0, 0, 0); group.add(yoke);
    // A ribbed spine tail hanging below (no legs — it floats).
    for (let i = 0; i < 4; i++) {
      const w = 0.3 - i * 0.05;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, w), mat(i % 2 ? bone : boneDark));
      seg.position.set(0, -0.28 - i * 0.26, 0); group.add(seg);
    }
    // Three skulls: a bigger central one, two smaller flanking ones.
    const heads = [
      { x: 0, y: 0.5, s: 0.5 },   // centre (highest, biggest)
      { x: -0.5, y: 0.28, s: 0.4 }, // left
      { x: 0.5, y: 0.28, s: 0.4 }   // right
    ];
    heads.forEach((h) => {
      const head = new THREE.Mesh(new THREE.BoxGeometry(h.s, h.s * 0.92, h.s * 0.92), mat(skull));
      head.position.set(h.x, h.y, 0); group.add(head);
      // A pair of glowing eyes on the front (+z) face of each skull.
      [-0.11 * (h.s / 0.5), 0.11 * (h.s / 0.5)].forEach((ex) => {
        const e = new THREE.Mesh(new THREE.BoxGeometry(0.09 * (h.s / 0.5), 0.09 * (h.s / 0.5), 0.05), eyeMat());
        e.position.set(h.x + ex, h.y + 0.02, h.s * 0.46 + 0.01); group.add(e);
      });
    });
    group.userData.kind = "wither";
    group.userData.heads = 3; // three skulls, and no legs
    return group;
  }
  World.makeWither = makeWither;

  // The Ender Dragon: a big, near-black winged beast with glowing PURPLE eyes. It
  // circles high over the End island and breathes purple fire. It's built facing
  // +z (its head and eyes on the front) so it can turn to face the player.
  function makeEnderDragon() {
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const body = 0x1b1723, dark = 0x0e0b13, wing = 0x271f34;
    // Glowing purple eyes — the dragon's signature.
    const eyeMat = () => new THREE.MeshLambertMaterial({ color: 0xc44cff, emissive: 0x8a1fd0 });

    // Torso.
    const torso = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.85, 1.9), mat(body));
    torso.position.set(0, 0, 0); group.add(torso);
    // Neck rising toward the head at the front (+z).
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.9), mat(body));
    neck.position.set(0, 0.32, 1.2); group.add(neck);
    // Head.
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 0.95), mat(body));
    head.position.set(0, 0.5, 1.95); group.add(head);
    // Lower jaw / snout.
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.22, 0.6), mat(dark));
    jaw.position.set(0, 0.2, 2.2); group.add(jaw);
    // Two glowing purple eyes on the front of the head.
    [-0.24, 0.24].forEach((x) => {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.1), eyeMat());
      e.position.set(x, 0.6, 2.36); group.add(e);
    });
    // A pair of brow horns.
    [-0.26, 0.26].forEach((x) => {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.28, 0.12), mat(dark));
      h.position.set(x, 0.9, 1.9); group.add(h);
    });
    // Broad wings, angled up, one per side.
    [-1, 1].forEach((s) => {
      const w = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, 1.1), mat(wing));
      w.position.set(s * 1.65, 0.4, -0.1); w.rotation.z = s * 0.28; group.add(w);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 0.7), mat(dark));
      tip.position.set(s * 2.9, 0.75, -0.1); tip.rotation.z = s * 0.28; group.add(tip);
    });
    // A tapering tail trailing behind (-z).
    for (let i = 0; i < 5; i++) {
      const w = 0.5 - i * 0.08;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(w, w, 0.55), mat(i % 2 ? body : dark));
      seg.position.set(0, -0.05 - i * 0.04, -1.15 - i * 0.5); group.add(seg);
    }
    // Four stubby legs tucked under the body.
    [[-0.4, 1], [0.4, 1], [-0.4, -1], [0.4, -1]].forEach(([x, zs]) => {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.4, 0.22), mat(dark));
      l.position.set(x, -0.55, zs * 0.6); group.add(l);
    });
    group.userData.kind = "ender_dragon";
    return group;
  }
  World.makeEnderDragon = makeEnderDragon;

  // A skeleton archer: a pale bony humanoid holding a little bow. It only comes
  // out at night on the surface, loosing arrows in random directions.
  function makeSkeleton() {
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const bone = 0xdad6cc, boneDark = 0xb7b2a5, dark = 0x2a2a2e, bowC = 0x7a5a30;
    // Legs
    [-0.12, 0.12].forEach((x) => {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.62, 0.13), mat(boneDark));
      l.position.set(x, 0.31, 0); group.add(l);
    });
    // Ribcage / body
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.18), mat(bone));
    body.position.set(0, 0.92, 0); group.add(body);
    // Arms (the front one holds the bow)
    [-0.28, 0.28].forEach((x) => {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.56, 0.1), mat(bone));
      a.position.set(x, 0.9, 0.06); group.add(a);
    });
    // Head / skull
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.38, 0.38), mat(bone));
    head.position.set(0, 1.42, 0); group.add(head);
    [-0.1, 0.1].forEach((x) => {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.05), mat(dark));
      e.position.set(x, 1.44, 0.19); group.add(e);
    });
    // A simple bow held out in front.
    const bow = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.06), mat(bowC));
    bow.position.set(0.3, 0.95, 0.16); group.add(bow);
    group.userData.kind = "skeleton";
    return group;
  }
  World.makeSkeleton = makeSkeleton;

  // A zombie: a shambling green brute with arms held out in front. It roams the
  // surface at night and hurts you if it bumps into you.
  function makeZombie() {
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const skin = 0x5a8f4a, skinDark = 0x477038, shirt = 0x3f6a86, dark = 0x050505;
    // Legs
    [-0.14, 0.14].forEach((x) => {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.5, 0.22), mat(skinDark));
      l.position.set(x, 0.25, 0); group.add(l);
    });
    // Body
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.6, 0.3), mat(shirt));
    body.position.set(0, 0.8, 0); group.add(body);
    // Arms held straight out in front (classic zombie).
    [-0.36, 0.36].forEach((x) => {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.6), mat(skin));
      a.position.set(x, 0.95, 0.35); group.add(a);
    });
    // Head
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.44, 0.44), mat(skin));
    head.position.set(0, 1.32, 0); group.add(head);
    // Sunken dark eyes
    [-0.11, 0.11].forEach((x) => {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, 0.05), mat(dark));
      e.position.set(x, 1.34, 0.22); group.add(e);
    });
    group.userData.kind = "zombie";
    return group;
  }
  World.makeZombie = makeZombie;

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
        this.fillColumn(x, z, floorY + 1, wallTop, "brown_bricks");
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
      this.fillColumn(x, z, floorY + 1, spireTop - 1, "bricks");
      this.blocks.set(World.key(x, spireTop, z), "wood_red"); // bright crown
      if (spireTop + 1 <= C.MAX_Y) this.blocks.set(World.key(x, spireTop + 1, z), "torch");
    });

    // 4) The central beacon mast — the very tallest point of the settlement.
    this.fillColumn(cx, cz, floorY + 1, Math.min(C.MAX_Y, mastTop - 1), "bricks");
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
    // Four settlement centres spread around the map (see planQuestSites), each
    // more elaborate than the last.
    const sites = this._sitePlan;
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

  // One settlement: a paved, walled keep with torch-topped corner towers and a
  // house in the middle holding the villager. Legacy worlds keep their original
  // sky-scraping spires; new worlds sit naturally in the landscape — the yellow
  // brick road is how you find them, not a beacon over the treetops.
  World.prototype.buildQuestSettlement = function (cx, cz, level, num) {
    const R = 5;
    const floorY = this.surfaceY(cx, cz);
    const wallTop = floorY + 2 + level;            // taller walls for later towns
    const spireTop = this.legacy ? C.MAX_Y - 1 : wallTop + 2; // modest corner towers
    const wallMat = ["brown_bricks", "brown_bricks", "bricks", "red_bricks"][level - 1] || "bricks";
    const crown = ["wood_red", "wood_blue", "wood_green", "wood_yellow"][level - 1] || "wood_red";

    // 1) Flatten + pave the plaza (fancier paving in the later settlements).
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const x = cx + dx, z = cz + dz;
        if (x < 1 || z < 1 || x >= C.WORLD - 1 || z >= C.WORLD - 1) continue;
        for (let y = floorY + 1; y <= C.MAX_Y + 3; y++) this.blocks.delete(World.key(x, y, z));
        this.fillColumn(x, z, Math.max(0, floorY - 1), floorY - 1, "dirt");
        const floorMat = level >= 3 ? (((dx + dz) & 1) ? "red_bricks" : "bricks") : "planks";
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
      this.fillColumn(x, z, floorY + 1, spireTop - 1, "bricks");
      this.blocks.set(World.key(x, spireTop, z), crown);
      if (spireTop + 1 <= C.MAX_Y) this.blocks.set(World.key(x, spireTop + 1, z), "torch");
    });

    // 4) The house in the middle, with the door / contents for this stage.
    this.buildQuestHouse(cx, cz, floorY, level, num);

    // 5) The FIRST settlement is a proper starter town, not just a house.
    if (num === 1) this.furnishStarterTown(cx, cz, floorY);
  };

  // Dress the first settlement up as a welcoming starter town: a crafting
  // corner (table + furnace + a stocked chest), a ripe melon patch, and a
  // little fenced pen in the corner with two farm animals.
  World.prototype.furnishStarterTown = function (cx, cz, floorY) {
    const y1 = floorY + 1;
    // Crafting corner along the east wall, lit by a torch.
    this.blocks.set(World.key(cx + 4, y1, cz - 1), "crafting_table");
    this.blocks.set(World.key(cx + 4, y1, cz), "furnace");
    this.blocks.set(World.key(cx + 4, y1, cz + 1), "chest");
    this.blocks.set(World.key(cx + 4, y1, cz - 2), "torch");
    this.starterChest = { x: cx + 4, y: y1, z: cz + 1 };
    // A ripe melon patch along the west wall.
    [[-4, -1], [-4, 0], [-4, 1], [-3, 0]].forEach(([dx, dz]) => {
      this.blocks.set(World.key(cx + dx, y1, cz + dz), "watermelon");
    });
    // A fenced pen sharing the settlement's corner walls, home to two animals.
    for (let d = 2; d <= 4; d++) {
      this.blocks.set(World.key(cx + 2, y1, cz + d), "fence");
      this.blocks.set(World.key(cx + d, y1, cz + 2), "fence");
    }
    const kinds = ["pig", "sheep"];
    kinds.forEach((kind, i) => {
      const pet = makeAnimal(kind);
      pet.position.set(cx + 3.3 + i * 0.9, y1, cz + 3.3 + i * 0.7);
      pet.userData.dir = i * 2.1;
      pet.userData.timer = 1 + i;
      pet.userData.hop = 0;
      this.animals.push(pet);
    });
  };

  // A little house in the centre of a settlement. House 1 has a plain door;
  // houses 2-4 are locked and need the matching key. House 3 hides the Nether
  // portal; house 4 holds the credits plaque.
  World.prototype.buildQuestHouse = function (cx, cz, floorY, level, num) {
    const hr = level >= 3 ? 3 : 2;                  // bigger houses later on
    const wall = num >= 3 ? "bricks" : "brown_bricks";
    const roof = num >= 3 ? "red_bricks" : "planks";
    const top = floorY + 3;                         // walls are 3 blocks tall
    // Only the FINAL house — the one holding the winning "Hall of Fame" screen —
    // is sealed so it can't be mined into. The others are ordinary buildings you
    // can dig through if you'd rather not chase down the keys.
    const seal = (x, y, z) => { if (num === 4) this.markProtected(x, y, z); };

    for (let dx = -hr; dx <= hr; dx++) {
      for (let dz = -hr; dz <= hr; dz++) {
        const x = cx + dx, z = cz + dz;
        // Seal the whole footprint's floor so you can't tunnel up into house 4.
        seal(x, floorY, z);
        const edge = Math.max(Math.abs(dx), Math.abs(dz)) === hr;
        if (!edge) continue;
        if (dz === -hr && dx === 0) {
          // The doorway: a door at foot height, clear space above, a lintel up
          // top. In new worlds the FOURTH house isn't locked at all — the real
          // challenge waits inside: an End Portal missing its 8 Eyes of Ender.
          const open = num === 1 || (num === 4 && !this.legacy);
          const doorId = open ? "door" : ("locked_door_" + num);
          this.blocks.set(World.key(x, floorY + 1, z), doorId);
          this.blocks.set(World.key(x, floorY + 3, z), wall);   // lintel (foot+2 stays open)
          seal(x, floorY + 1, z);                               // the (locked) door
          seal(x, floorY + 3, z);                               // the lintel above it
        } else {
          this.fillColumn(x, z, floorY + 1, top, wall);
          if ((Math.abs(dx) + Math.abs(dz)) % 2 === 0) this.blocks.set(World.key(x, floorY + 2, z), "glass");
          for (let y = floorY + 1; y <= top; y++) seal(x, y, z); // walls + windows
        }
      }
    }
    // Flat roof.
    for (let dx = -hr; dx <= hr; dx++) {
      for (let dz = -hr; dz <= hr; dz++) {
        this.blocks.set(World.key(cx + dx, floorY + 4, cz + dz), roof);
        seal(cx + dx, floorY + 4, cz + dz);
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
    // House 4 holds the way into The End — the grand finale of the adventure.
    // Legacy worlds keep their ready-lit portal behind the gold-key door; new
    // worlds hold a dormant End Portal frame with 8 empty eye sockets instead.
    if (num === 4) {
      if (this.legacy) this.buildPortal(cx, floorY + 1, cz + hr - 1, "end_portal");
      else this.buildEndGate(cx, floorY + 1, cz + hr - 1);
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
      // The trade that advances the quest. In legacy worlds the third villager
      // sells the gold key for netherite; in new worlds the fourth house is
      // open, so the third villager is an ordinary (emerald-loving) trader.
      if (num === 1) v.userData.quest = { gives: "key2" };
      else if (num === 2) v.userData.quest = { gives: "key3" };
      else if (num === 3 && this.legacy) v.userData.quest = { gives: "key4", cost: { id: "netherite", count: 1 } };
      this.questVillagers.push(v);
      this.animals.push(v);
    }
  };

  // A 1-wide, 2-tall glowing portal framed in obsidian, centred on (x,z) with its
  // base at y. Used for the Nether portals (default) and the End portal (pass
  // "end_portal") that lives in the fourth house.
  World.prototype.buildPortal = function (x, y, z, portalId) {
    const O = "obsidian";
    portalId = portalId || "nether_portal";
    this.blocks.set(World.key(x, y - 1, z), O);     // sill
    this.blocks.set(World.key(x, y + 2, z), O);     // lintel
    for (let dy = 0; dy < 2; dy++) {
      this.blocks.set(World.key(x - 1, y + dy, z), O);
      this.blocks.set(World.key(x + 1, y + dy, z), O);
      this.blocks.set(World.key(x, y + dy, z), portalId);
    }
    return { x: x, y: y, z: z };
  };

  // ================================================================
  //  The End Gate: a dormant End Portal in the fourth house. Its arch
  //  is made of 8 frame blocks, each with an empty eye socket — place
  //  all 8 Eyes of Ender (from the Nether fortress chest) to light the
  //  portal. Pop any eye back out and it falls dark again.
  // ================================================================
  // The 8 sockets form an arch around the 1-wide, 2-tall doorway at (x, y..y+1):
  // a sill in the floor, two side columns, and a three-block lintel row.
  World.prototype.buildEndGate = function (x, y, z) {
    const sockets = [
      { x: x, y: y - 1, z: z },                        // sill (flush with the floor)
      { x: x - 1, y: y, z: z }, { x: x + 1, y: y, z: z },
      { x: x - 1, y: y + 1, z: z }, { x: x + 1, y: y + 1, z: z },
      { x: x - 1, y: y + 2, z: z }, { x: x, y: y + 2, z: z }, { x: x + 1, y: y + 2, z: z }
    ];
    sockets.forEach((c) => {
      this.blocks.set(World.key(c.x, c.y, c.z), "end_frame");
      this.markProtected(c.x, c.y, c.z);               // eyes go in and out; no mining
    });
    this.markProtected(x, y, z);                       // the portal cells themselves
    this.markProtected(x, y + 1, z);
    this.endGate = { x: x, y: y, z: z, sockets: sockets };
  };

  // How many of the gate's sockets currently hold an Eye of Ender?
  World.prototype.endGateEyes = function () {
    if (!this.endGate) return 0;
    let n = 0;
    this.endGate.sockets.forEach((c) => { if (this.get(c.x, c.y, c.z) === "end_frame_eye") n++; });
    return n;
  };

  // Light (or darken) the portal inside the frame. Recorded as normal edits, so
  // a saved game reloads with the portal exactly as the player left it.
  World.prototype.setEndGateActive = function (on) {
    const g = this.endGate;
    if (!g) return;
    this.setBlock(g.x, g.y, g.z, on ? "end_portal" : null);
    this.setBlock(g.x, g.y + 1, g.z, on ? "end_portal" : null);
  };

  // ================================================================
  //  The Woodland Mansion: a grand two-storey dark-oak manor hidden
  //  deep in the roofed forest, with treasure chests waiting inside.
  // ================================================================
  World.prototype.buildWoodlandMansion = function () {
    const g = this._grove;
    if (!g) return;
    const cx = g.x, cz = g.z;
    const HX = 8, HZ = 6;                       // half-footprint: 17 x 13 blocks
    const floorY = Math.max(4, Math.min(9, this.surfaceY(cx, cz)));
    const y1 = floorY + 1;                      // ground-floor walk level
    const slabY = floorY + 5;                   // the upstairs floor
    const top2 = slabY + 4;                     // top of the upper walls
    const wall = "dark_planks", beam = "dark_wood";
    const inBounds = (x, z) => x >= 1 && z >= 1 && x < C.WORLD - 1 && z < C.WORLD - 1;

    // 1) Clear and level the grounds: the footprint plus a 2-block lawn.
    for (let dx = -HX - 2; dx <= HX + 2; dx++) {
      for (let dz = -HZ - 2; dz <= HZ + 2; dz++) {
        const x = cx + dx, z = cz + dz;
        if (!inBounds(x, z)) continue;
        for (let y = floorY + 1; y <= C.MAX_Y + 3; y++) this.blocks.delete(World.key(x, y, z));
        // Bridge any dip between the real ground and the mansion floor.
        for (let y = this.surfaceY(x, z) + 1; y < floorY; y++) this.blocks.set(World.key(x, y, z), "dirt");
        const inside = Math.abs(dx) <= HX && Math.abs(dz) <= HZ;
        this.blocks.set(World.key(x, floorY, z), inside ? "dark_planks" : "dark_grass");
      }
    }

    // 2) Two storeys of walls: dark-plank panels between dark-wood beams, with
    //    a row of windows on each floor and a grand 3-wide front doorway (-z).
    for (let dx = -HX; dx <= HX; dx++) {
      for (let dz = -HZ; dz <= HZ; dz++) {
        if (Math.abs(dx) !== HX && Math.abs(dz) !== HZ) continue; // edge cells only
        const x = cx + dx, z = cz + dz;
        if (!inBounds(x, z)) continue;
        const doorway = dz === -HZ && Math.abs(dx) <= 1;
        if (doorway) {
          // Double doors with a windowed centre door, clear space above, then a
          // dark-wood lintel and the wall carrying on over the top.
          this.blocks.set(World.key(x, y1, z), dx === 0 ? "door_window" : "door");
          this.blocks.set(World.key(x, y1 + 2, z), beam);   // lintel (y1+1 stays open)
          for (let y = y1 + 3; y <= top2; y++) this.blocks.set(World.key(x, y, z), wall);
          continue;
        }
        const corner = Math.abs(dx) === HX && Math.abs(dz) === HZ;
        const isBeam = corner ||
          (Math.abs(dx) === HX && dz % 4 === 0) ||
          (Math.abs(dz) === HZ && dx % 4 === 0);
        for (let y = y1; y <= top2; y++) this.blocks.set(World.key(x, y, z), isBeam ? beam : wall);
        if (!isBeam) {
          this.blocks.set(World.key(x, y1 + 1, z), "glass");    // ground-floor window
          this.blocks.set(World.key(x, slabY + 2, z), "glass"); // upstairs window
        }
      }
    }

    // 3) The upstairs floor slab, minus the stairwell opening along the +x wall.
    for (let dx = -HX + 1; dx <= HX - 1; dx++) {
      for (let dz = -HZ + 1; dz <= HZ - 1; dz++) {
        if (dx === HX - 1 && dz >= -2 && dz <= 1) continue; // stairwell stays open
        this.blocks.set(World.key(cx + dx, slabY, cz + dz), "dark_planks");
      }
    }
    // A straight flight of stairs up the +x wall (walk straight up, no jumps).
    for (let i = 0; i <= 4; i++) {
      this.blocks.set(World.key(cx + HX - 1, y1 + i, cz - 2 + i), "stairs");
    }

    // 4) A steep stepped roof, capped with a dark-wood ridge beam.
    for (let L = 0; L <= 3; L++) {
      const zHalf = (L === 0 ? HZ + 1 : HZ + 1 - 2 * L);
      const xHalf = HX + (L === 0 ? 1 : 0);   // the lowest course overhangs
      for (let dx = -xHalf; dx <= xHalf; dx++) {
        for (let dz = -zHalf; dz <= zHalf; dz++) {
          const x = cx + dx, z = cz + dz;
          if (!inBounds(x, z)) continue;
          const mat = (L === 3 && dz === 0) ? beam : wall;
          this.blocks.set(World.key(x, top2 + 1 + L, z), mat);
        }
      }
    }

    // 5) Furnishings: torches in every corner of both floors, a work corner
    //    with a crafting table and furnace, beds, and the two treasure chests.
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => {
      this.blocks.set(World.key(cx + sx * (HX - 2), y1, cz + sz * (HZ - 2)), "torch");
      this.blocks.set(World.key(cx + sx * (HX - 2), slabY + 1, cz + sz * (HZ - 2)), "torch");
    });
    this.blocks.set(World.key(cx - 3, y1, cz + HZ - 2), "crafting_table");
    this.blocks.set(World.key(cx - 2, y1, cz + HZ - 2), "furnace");
    this.blocks.set(World.key(cx + 2, y1, cz + HZ - 2), "bed");
    this.blocks.set(World.key(cx + 4, y1, cz + HZ - 2), "bed");
    // Torches flanking the front doors outside, so the mansion glows at night.
    this.blocks.set(World.key(cx - 2, y1, cz - HZ - 1), "torch");
    this.blocks.set(World.key(cx + 2, y1, cz - HZ - 1), "torch");

    this.mansionChests = [];
    const c1 = { x: cx - HX + 2, y: y1, z: cz + HZ - 2 };        // ground floor
    const c2 = { x: cx - HX + 2, y: slabY + 1, z: cz - HZ + 2 }; // upstairs
    [c1, c2].forEach((c) => {
      this.blocks.set(World.key(c.x, c.y, c.z), "chest");
      this.mansionChests.push(c);
    });
    this.mansion = { x: cx, y: floorY, z: cz };
  };

  // Try to light a Nether portal from an obsidian block struck with flint &
  // steel. Looks for a flat, obsidian-ringed pocket of air touching this block
  // (in either vertical plane) and fills it with glowing portal blocks. Returns
  // the list of lit portal cell keys if a portal was lit, or null otherwise.
  World.prototype.lightPortal = function (bx, by, bz) {
    if (this.get(bx, by, bz) !== "obsidian") return null;
    // Two candidate portal planes: one spanning X & Y (fixed z, faces ±z), one
    // spanning Z & Y (fixed x, faces ±x). We only travel along the plane's axes.
    const planes = [
      [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]],
      [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]
    ];
    for (const dirs of planes) {
      for (const d of dirs) {
        const sx = bx + d[0], sy = by + d[1], sz = bz + d[2];
        if (this.occupied(sx, sy, sz)) continue;      // seed must be open air
        const cells = this.portalPocket(sx, sy, sz, dirs);
        if (cells) {
          cells.forEach((k) => {
            const p = k.split(",");
            this.setBlock(+p[0], +p[1], +p[2], "nether_portal");
          });
          return cells;
        }
      }
    }
    return null;
  };

  // Flood-fill empty cells within a plane from a seed. Returns the list of cell
  // keys if it's a small pocket fully ringed by obsidian, or null if the air
  // escapes (no complete frame) or something else lines the edge.
  World.prototype.portalPocket = function (sx, sy, sz, dirs) {
    const MAX = 40;
    const seen = new Set([World.key(sx, sy, sz)]);
    const stack = [[sx, sy, sz]];
    const cells = [];
    while (stack.length) {
      const [x, y, z] = stack.pop();
      cells.push(World.key(x, y, z));
      if (cells.length > MAX) return null;             // ran away — not enclosed
      for (const d of dirs) {
        const nx = x + d[0], ny = y + d[1], nz = z + d[2];
        const id = this.get(nx, ny, nz);
        if (id === "obsidian") continue;               // a good frame edge
        if (id) return null;                           // some other block — not a clean frame
        if (ny < 0) return null;                       // escaped below the world
        const k = World.key(nx, ny, nz);
        if (!seen.has(k)) { seen.add(k); stack.push([nx, ny, nz]); }
      }
    }
    return cells.length ? cells : null;
  };

  // Flood the connected run of nether_portal blocks starting at (x,y,z),
  // returning their cell keys (the whole "sheet" of purple light).
  World.prototype.portalCellsFrom = function (x, y, z) {
    if (this.get(x, y, z) !== "nether_portal") return [];
    const seen = new Set([World.key(x, y, z)]);
    const stack = [[x, y, z]];
    const cells = [];
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    while (stack.length && cells.length < 60) {
      const [cx, cy, cz] = stack.pop();
      cells.push(World.key(cx, cy, cz));
      for (const d of dirs) {
        const nx = cx + d[0], ny = cy + d[1], nz = cz + d[2];
        if (this.get(nx, ny, nz) !== "nether_portal") continue;
        const k = World.key(nx, ny, nz);
        if (!seen.has(k)) { seen.add(k); stack.push([nx, ny, nz]); }
      }
    }
    return cells;
  };

  // A portal is only alive while its purple cells are fully framed by obsidian.
  // Given the connected portal cells, decide which vertical plane they lie in,
  // then confirm every in-plane neighbour is either portal or obsidian. Returns
  // true if the frame is complete.
  World.prototype.portalIntact = function (cells) {
    if (!cells.length) return false;
    const coords = cells.map((k) => k.split(",").map(Number));
    const inSet = new Set(cells);
    const xs = new Set(coords.map((c) => c[0]));
    const zs = new Set(coords.map((c) => c[2]));
    // Pick the horizontal axis the portal spans. A single column is ambiguous,
    // so choose whichever axis actually has obsidian beside it.
    let axis; // "x" or "z"
    if (xs.size > 1) axis = "x";
    else if (zs.size > 1) axis = "z";
    else {
      const c = coords[0];
      const xFrame = this.get(c[0] - 1, c[1], c[2]) === "obsidian" || this.get(c[0] + 1, c[1], c[2]) === "obsidian";
      axis = xFrame ? "x" : "z";
    }
    const dirs = axis === "x"
      ? [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]
      : [[0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
    for (const c of coords) {
      for (const d of dirs) {
        const k = World.key(c[0] + d[0], c[1] + d[1], c[2] + d[2]);
        if (inSet.has(k)) continue;                 // another portal cell — fine
        if (this.get(c[0] + d[0], c[1] + d[1], c[2] + d[2]) !== "obsidian") return false;
      }
    }
    return true;
  };

  // After an obsidian block at (x,y,z) is removed, any portal that touched it may
  // no longer be framed. Snuff out (delete) every such broken portal. Returns an
  // array of the removed portals, each { cells:[...], id: minCellKey }, so the
  // game can also tear down any linked portal in the other dimension.
  World.prototype.snuffBrokenPortals = function (x, y, z) {
    const removed = [];
    const done = new Set();
    const neighbours = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const d of neighbours) {
      const nx = x + d[0], ny = y + d[1], nz = z + d[2];
      if (this.get(nx, ny, nz) !== "nether_portal") continue;
      const cells = this.portalCellsFrom(nx, ny, nz);
      const id = World.portalId(cells);
      if (done.has(id)) continue;
      done.add(id);
      if (!this.portalIntact(cells)) {
        cells.forEach((k) => {
          const p = k.split(",");
          this.setBlock(+p[0], +p[1], +p[2], null);
        });
        removed.push({ cells: cells, id: id });
      }
    }
    return removed;
  };

  // A stable identity for a portal: the lexicographically smallest of its cells.
  World.portalId = function (cells) {
    let best = null;
    for (const k of cells) if (best === null || k < best) best = k;
    return best;
  };

  // Carve out a fresh 1-wide, 2-tall lit portal on the Nether floor at (px,pz),
  // clearing room around it and giving a tidy netherrack floor. Uses setBlock so
  // an already-rendered Nether re-meshes. Returns { pos, cells, spawn }.
  World.prototype.openNetherPortalAt = function (px, pz) {
    const FLOOR = 2, base = FLOOR + 1, O = "obsidian";
    for (let x = px - 2; x <= px + 2; x++) {
      for (let z = pz - 1; z <= pz + 3; z++) {
        for (let y = base; y <= base + 4; y++) this.setBlock(x, y, z, null);
        this.setBlock(x, FLOOR, z, "netherrack");
      }
    }
    this.setBlock(px, base - 1, pz, O);   // sill
    this.setBlock(px, base + 2, pz, O);   // lintel
    const cells = [];
    for (let dy = 0; dy < 2; dy++) {
      this.setBlock(px - 1, base + dy, pz, O);
      this.setBlock(px + 1, base + dy, pz, O);
      this.setBlock(px, base + dy, pz, "nether_portal");
      cells.push(World.key(px, base + dy, pz));
    }
    return { pos: { x: px, y: base, z: pz }, cells: cells,
      spawn: { x: px + 0.5, y: base, z: pz + 2.5 } };
  };

  // Find a clear floor spot in the Nether interior to drop a new portal, away
  // from lava, the existing portals and the fortress.
  World.prototype.findNetherPortalSpot = function () {
    const SZ = C.WORLD, FLOOR = 2;
    const clear = (px, pz) => {
      for (let x = px - 1; x <= px + 1; x++)
        for (let z = pz - 1; z <= pz + 3; z++) {
          if (this.get(x, FLOOR, z) === "lava") return false;
          if (this.get(x, FLOOR + 1, z) === "nether_portal") return false;
        }
      return true;
    };
    for (let tries = 0; tries < 200; tries++) {
      const px = 6 + Math.floor(Math.random() * (SZ - 12));
      const pz = 6 + Math.floor(Math.random() * (SZ - 12));
      if (clear(px, pz)) return { x: px, z: pz };
    }
    return { x: (SZ >> 1), z: (SZ >> 1) }; // fallback: the middle
  };

  // ================================================================
  //  The Nether: a fiery cavern of netherrack, lava, ghasts & netherite.
  // ================================================================
  World.prototype.generateNether = function () {
    this.isNether = true;
    this.fireballs = [];
    this.skulls = [];
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

    // Lava pools, glowstone lights and a few netherrack pillars. Netherite is
    // now VERY rare to mine — the reliable ways to get it are the fortress chest
    // and the piglin trade, so only the odd speck hides in the floor.
    for (let x = 2; x < SZ - 2; x++) {
      for (let z = 2; z < SZ - 2; z++) {
        if (Game.hash(this.seed ^ 0x9e7, x, FLOOR, z) < 0.004) this.blocks.set(World.key(x, FLOOR, z), "netherite_ore");
        if (Game.hash(this.seed ^ 0x9e8, x, FLOOR - 1, z) < 0.004) this.blocks.set(World.key(x, FLOOR - 1, z), "netherite_ore");
        if (Game.hash(this.seed ^ 0x47e, x, 1, z) < 0.03) this.blocks.set(World.key(x, FLOOR, z), "lava");
        if (Game.hash(this.seed ^ 0x6105, x, 0, z) < 0.025) this.blocks.set(World.key(x, CEIL - 1, z), "glowstone");
        if (Game.hash(this.seed ^ 0xb09, x, 0, z) < 0.02) {
          const h = 1 + Math.floor(Game.hash(this.seed ^ 0xb10, x, 0, z) * 5);
          for (let y = FLOOR + 1; y <= FLOOR + h; y++) this.blocks.set(World.key(x, y, z), "netherrack");
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

    // A brick fortress in the far corner, holding a chest of netherite.
    this.fortressChests = [];
    const fortX = SZ - 8, fortZ = SZ - 8;
    this.buildNetherFortress(fortX, fortZ);

    // Floating ghasts that drift overhead and spit fire (more of them in the
    // big open-world Nether, so the longer trek stays exciting).
    const rng = Game.mulberry32(this.seed ^ 0x6ace);
    for (let i = 0; i < (this.legacy ? 4 : 8); i++) {
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
      g.userData.hasFired = false; // fires just once per Nether visit
      this.animals.push(g);
    }

    // A few piglins snuffling around the floor, ready to trade.
    for (let i = 0; i < (this.legacy ? 2 : 4); i++) {
      const pg = makePiglin();
      let gx, gz, tries = 0;
      do {
        gx = 8 + Math.floor(rng() * (SZ - 16));
        gz = 8 + Math.floor(rng() * (SZ - 16));
        tries++;
      } while (tries < 30 && this.get(gx, FLOOR, gz) === "lava");
      pg.position.set(gx + 0.5, FLOOR + 1, gz + 0.5);
      pg.userData.dir = rng() * Math.PI * 2;
      pg.userData.timer = rng() * 3;
      this.animals.push(pg);
    }

    // A single Wither floats guard over the fortress, flinging wither skulls.
    const wither = makeWither();
    let gx = fortX - 5, gz = fortZ, tries = 0;
    while (tries < 30 && (gx < 3 || gz < 3 || gx >= SZ - 3 || gz >= SZ - 3 ||
           this.get(gx, FLOOR, gz) === "lava")) {
      gx = fortX + Math.floor((rng() - 0.5) * 12);
      gz = fortZ + Math.floor((rng() - 0.5) * 12);
      tries++;
    }
    const wy = FLOOR + 3.5;                 // it hovers, no legs to stand on
    wither.position.set(gx + 0.5, wy, gz + 0.5);
    wither.userData.home = { x: gx + 0.5, z: gz + 0.5 };
    wither.userData.baseY = wy;
    wither.userData.roam = 5;
    wither.userData.dir = rng() * Math.PI * 2;
    wither.userData.timer = rng() * 2;
    wither.userData.t = rng() * Math.PI * 2;
    wither.userData.skullTimer = 1.5 + rng() * 2.5;
    this.animals.push(wither);
  };

  // A two-storey Nether fortress: a red-brick keep with a ground-floor doorway,
  // a flight of BRICK STAIRS up one side to a second-floor deck, and the loot
  // chest waiting up top. Lit by glowstone on both floors. The chest position is
  // recorded on fortressChests so the game can stock it on first visit.
  World.prototype.buildNetherFortress = function (cx, cz) {
    const FLOOR = 2, R = 3;
    const base = FLOOR + 1;      // 3  — ground-floor walk level
    const groundTop = base + 3;  // 6  — top of the ground-floor walls
    const deckY = base + 4;      // 7  — second-floor deck blocks (walk on top at 8)
    const upTop = deckY + 3;     // 10 — top of the upper walls
    const roofY = upTop + 1;     // 11 — roof
    const wall = "red_bricks", floorMat = "brown_bricks", deckMat = "brown_bricks";
    const inBounds = (x, z) => x >= 1 && z >= 1 && x < C.WORLD - 1 && z < C.WORLD - 1;

    // 1) Clear the whole volume and lay a solid ground floor.
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const x = cx + dx, z = cz + dz;
        if (!inBounds(x, z)) continue;
        for (let y = base; y <= roofY + 1; y++) this.blocks.delete(World.key(x, y, z));
        this.blocks.set(World.key(x, FLOOR, z), floorMat);
      }
    }

    // 2) Perimeter walls (both storeys) with a 2-tall doorway on the -z side.
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue; // edge cells only
        const x = cx + dx, z = cz + dz;
        if (!inBounds(x, z)) continue;
        for (let y = base; y <= upTop; y++) {
          if (dz === -R && dx === 0 && y <= base + 1) continue;   // doorway
          this.blocks.set(World.key(x, y, z), wall);
        }
      }
    }

    // 3) Flat roof.
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const x = cx + dx, z = cz + dz;
        if (inBounds(x, z)) this.blocks.set(World.key(x, roofY, z), wall);
      }
    }

    // 4) Second-floor deck across the interior, leaving the +x column open as
    //    the stairwell.
    const IN = R - 1; // interior half-width (2)
    for (let dx = -IN; dx <= IN; dx++) {
      for (let dz = -IN; dz <= IN; dz++) {
        if (dx === IN) continue; // stairwell column stays open
        this.blocks.set(World.key(cx + dx, deckY, cz + dz), deckMat);
      }
    }

    // 5) Brick stairs rising along the +x wall from the ground to the deck.
    for (let i = 0; i <= 4; i++) {
      this.blocks.set(World.key(cx + IN, base + i, cz - IN + i), "brick_stairs");
    }

    // 6) Glowstone lamps: one in the deck (lights the ground floor from its
    //    ceiling) and one hung under the roof for the upper floor.
    this.blocks.set(World.key(cx - IN + 1, deckY, cz - IN + 1), "glowstone");
    this.blocks.set(World.key(cx, upTop, cz), "glowstone");

    // 7) The treasure chest sits up on the second-floor deck.
    const chestCell = { x: cx - IN, y: deckY + 1, z: cz + IN };
    this.blocks.set(World.key(chestCell.x, chestCell.y, chestCell.z), "chest");
    this.fortressChests.push(chestCell);
  };

  // ================================================================
  //  The End: a dark starry void with a pale island, four soaring
  //  spiral staircases crowned with End Crystals, and the Ender Dragon
  //  circling overhead breathing purple fire. There is NO portal back
  //  to the overworld — the only way out is the Exit Portal you craft
  //  from four End Crystals.
  // ================================================================
  World.prototype.generateEnd = function () {
    this.isEnd = true;
    this.fireballs = [];
    this.skulls = [];                 // (kept so shared projectile helpers are safe)
    const SZ = C.WORLD, FLOOR = 3;
    const cx = Math.floor(SZ / 2), cz = Math.floor(SZ / 2);

    // A solid End-stone island paves the whole floor, so you never tumble into
    // the endless void below.
    for (let x = 0; x < SZ; x++) {
      for (let z = 0; z < SZ; z++) {
        for (let y = 0; y <= FLOOR; y++) this.blocks.set(World.key(x, y, z), "end_stone");
      }
    }

    // You arrive on the island, looking toward its heart.
    this.spawn = { x: cx + 0.5, y: FLOOR + 1, z: cz + 0.5 };

    // Four VERY tall spiral staircases, each crowned with an End Crystal.
    this.endCrystals = [];
    const R = 8, baseY = FLOOR + 1, height = 18;
    [[-R, -R], [R, -R], [-R, R], [R, R]].forEach(([dx, dz]) => {
      this.buildEndSpiral(cx + dx, cz + dz, baseY, height);
    });

    // The Ender Dragon glides in a slow circle high above the island.
    const dragon = makeEnderDragon();
    const baseDragonY = FLOOR + 14;
    dragon.position.set(cx + 12, baseDragonY, cz);
    dragon.userData.baseY = baseDragonY;
    dragon.userData.center = { x: cx + 0.5, z: cz + 0.5 };
    dragon.userData.angle = 0;
    dragon.userData.t = 0;
    dragon.userData.fireTimer = 2.5;
    this.animals.push(dragon);
  };

  // One spiral staircase: a central obsidian column with `stairs` spiralling up
  // around it (so you can walk straight up, no jumping), crowned with an End
  // Crystal on top. The eight cells that ring the column, taken in order, are
  // each edge-adjacent to the next, so a step per cell makes a smooth climb.
  World.prototype.buildEndSpiral = function (px, pz, baseY, height) {
    const ring = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
    const topY = baseY + height;          // the block the crystal sits on is topY-1
    // Central support column, grounded on the island and rising to just under
    // the crystal.
    for (let y = baseY - 1; y < topY; y++) this.blocks.set(World.key(px, y, pz), "obsidian");
    // The spiralling steps.
    for (let i = 0; i < height; i++) {
      const [dx, dz] = ring[i % ring.length];
      this.blocks.set(World.key(px + dx, baseY + i, pz + dz), "stairs");
    }
    // The End Crystal on top of the column.
    this.blocks.set(World.key(px, topY, pz), "end_crystal");
    this.endCrystals.push({ x: px, y: topY, z: pz });
  };

  // Drive The End: fly the dragon in its circle, let it breathe purple fire at
  // the player, and move the fire along. Called each frame while you're in the
  // End. Wearing armour (you're given a set on arrival) stops the fire cold.
  World.prototype.updateEnd = function (dt, player) {
    const eye = player.eyePosition();
    for (const a of this.animals) {
      if (a.userData.kind !== "ender_dragon") continue;
      const u = a.userData;
      u.t += dt;
      // A slow, banking circle high over the island, with a gentle bob.
      u.angle += dt * 0.4;
      const R = 12;
      a.position.x = u.center.x + Math.cos(u.angle) * R;
      a.position.z = u.center.z + Math.sin(u.angle) * R;
      a.position.y = u.baseY + Math.sin(u.t * 0.8) * 1.3;
      a.rotation.y = Math.atan2(eye.x - a.position.x, eye.z - a.position.z); // face the player

      // Breathe a short burst of purple fire toward the player now and then.
      u.fireTimer -= dt;
      if (u.fireTimer <= 0) {
        u.fireTimer = 1.6 + Math.random() * 1.4;
        const dx = eye.x - a.position.x, dy = eye.y - a.position.y, dz = eye.z - a.position.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 32 && dist > 2) {
          const nx = dx / dist, ny = dy / dist, nz = dz / dist;
          const mouth = { x: a.position.x + nx * 1.8, y: a.position.y + 0.2 + ny * 1.8, z: a.position.z + nz * 1.8 };
          for (let k = 0; k < 3; k++) {
            const sx = nx + (Math.random() - 0.5) * 0.14;
            const sy = ny + (Math.random() - 0.5) * 0.14;
            const sz = nz + (Math.random() - 0.5) * 0.14;
            const l = Math.hypot(sx, sy, sz) || 1;
            this.spawnFireball(mouth, { x: sx / l, y: sy / l, z: sz / l }, { purple: true });
          }
        }
      }
    }
    this.updateFireballs(dt, player);
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

  // ---- Anti-twitch helpers ---------------------------------------
  // Ease a critter's body toward the way it's walking instead of snapping.
  // Combined with the turn pause below, a blocked animal calmly looks around
  // for a new way out rather than spinning like a top.
  function faceYaw(a, target, dt) {
    let d = target - a.rotation.y;
    d = ((d % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI; // shortest way round
    a.rotation.y += d * Math.min(1, dt * 6);
  }

  // A blocked wanderer turns around (with a little randomness) — but only a
  // few times a second. Re-picking a direction EVERY frame while stuck was
  // what caused the hyperactive twitching.
  function turnWhenBlocked(u) {
    if (u.turnPause > 0) return;
    u.dir += Math.PI * (0.75 + Math.random() * 0.5);
    u.turnPause = 0.35 + Math.random() * 0.3;
  }

  // An animal whose own cell has become un-standable (a wall or house was
  // built right on top of its meadow) pops free to the nearest open spot.
  // Animals penned in by fences never trigger this — their own cell is fine.
  World.prototype.unstickAnimal = function (a) {
    const ax = Math.floor(a.position.x), az = Math.floor(a.position.z);
    for (let r = 1; r <= 6; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = ax + dx + 0.5, z = az + dz + 0.5;
          const y = this.surfaceY(ax + dx, az + dz) + 1;
          if (!this.canStand(x, z, y)) continue;
          a.position.set(x, y, z);
          return true;
        }
      }
    }
    return false;
  };

  // Shared walking step for every ground wanderer: advance if the way is
  // clear, otherwise turn (paced), and pop free if genuinely stuck.
  World.prototype.wanderStep = function (a, dt, speed) {
    const u = a.userData;
    if (u.turnPause > 0) u.turnPause -= dt;
    const nx = a.position.x + Math.cos(u.dir) * speed * dt;
    const nz = a.position.z + Math.sin(u.dir) * speed * dt;
    if (this.canStand(nx, nz, a.position.y)) {
      a.position.x = nx; a.position.z = nz;
      u.stuckFor = 0;
    } else {
      turnWhenBlocked(u);
      u.stuckFor = (u.stuckFor || 0) + dt;
      if (u.stuckFor > 3) { this.unstickAnimal(a); u.stuckFor = 0; }
    }
    const sy = this.surfaceY(Math.floor(a.position.x), Math.floor(a.position.z)) + 1;
    a.position.y += (sy - a.position.y) * Math.min(1, dt * 8);
    faceYaw(a, -u.dir + Math.PI / 2, dt);
  };

  World.prototype.updateAnimals = function (dt) {
    for (const a of this.animals) {
      if (Game.S && Game.S.riding === a) continue; // the rider drives this one
      if (a.userData.kind === "monkey") { this.updateMonkey(a, dt); continue; }
      if (a.userData.kind === "villager") { this.updateVillager(a, dt); continue; }
      // Ghasts, piglins and the wither are driven by updateNether.
      if (a.userData.kind === "ghast" || a.userData.kind === "piglin" ||
          a.userData.kind === "wither") continue;
      // The Ender Dragon is driven by updateEnd.
      if (a.userData.kind === "ender_dragon") continue;
      // Skeletons and zombies are driven by updateNight (only awake after dark).
      if (a.userData.kind === "skeleton" || a.userData.kind === "zombie") continue;

      // Ground animals just walk around on the surface — no hopping/floating.
      a.userData.timer -= dt;
      if (a.userData.timer <= 0) {
        a.userData.timer = 1.5 + Math.random() * 3;
        a.userData.dir = Math.random() * Math.PI * 2;
      }
      let speed = 0.7;
      if (a.userData.hop > 0) { a.userData.hop -= dt; speed = 1.9; } // spooked: trot off
      // Walk on if the way is clear; turn calmly at borders and fences.
      this.wanderStep(a, dt, speed);
    }
  };

  // Night on the surface: skeletons wake up, roam, and loose arrows in random
  // directions. By day they vanish and any arrows fizzle out. Called from the
  // main loop while you're in the overworld.
  World.prototype.updateNight = function (dt, player, isNight) {
    for (const a of this.animals) {
      const kind = a.userData.kind;
      if (kind !== "skeleton" && kind !== "zombie") continue;
      if (!isNight) { a.visible = false; a.userData.nightPlaced = false; continue; } // both vanish by day
      // Each nightfall the monsters creep in out of the dark to prowl NEAR the
      // player. (They used to wake wherever they happened to be on the big
      // map — most nights you'd never even see one.)
      if (!a.userData.nightPlaced) { a.userData.nightPlaced = true; this.stalkPlayer(a, player); }
      if (kind === "skeleton") this.updateSkeleton(a, dt, player);
      else this.updateZombie(a, dt, player);
    }
    this.updateArrows(dt, player);
  };

  // Drop a night monster somewhere standable 10-22 blocks from the player —
  // close enough to run into, far enough that it isn't right on top of them.
  World.prototype.stalkPlayer = function (a, player) {
    for (let t = 0; t < 24; t++) {
      const ang = Math.random() * Math.PI * 2;
      const d = 10 + Math.random() * 12;
      const x = Math.floor(player.pos.x + Math.cos(ang) * d);
      const z = Math.floor(player.pos.z + Math.sin(ang) * d);
      if (x < 3 || z < 3 || x >= C.WORLD - 3 || z >= C.WORLD - 3) continue;
      const y = this.surfaceY(x, z) + 1;
      if (!this.canStand(x + 0.5, z + 0.5, y)) continue;
      a.position.set(x + 0.5, y, z + 0.5);
      return;
    }
    // No luck (odd terrain everywhere) — it just wakes wherever it slept.
  };

  // A zombie shambles about the surface at random. If it lurches into the player
  // it takes a bite — one heart, then a short pause before it can bite again.
  World.prototype.updateZombie = function (a, dt, player) {
    a.visible = true;
    const u = a.userData;
    u.timer -= dt;
    if (u.timer <= 0) { u.timer = 1.2 + Math.random() * 2.5; u.dir = Math.random() * Math.PI * 2; }
    this.wanderStep(a, dt, 0.8);

    // Bump into the player? Take a bite (with a cooldown so it isn't instant death).
    if (u.hitCooldown > 0) u.hitCooldown -= dt;
    const dx = player.pos.x - a.position.x, dz = player.pos.z - a.position.z;
    const dy = player.pos.y - a.position.y;
    if (u.hitCooldown <= 0 && dx * dx + dz * dz < 0.9 * 0.9 && Math.abs(dy) < 2) {
      if (Game.hasDefense && Game.hasDefense()) {
        if (Game.toast) Game.toast("🛡️ Your armour shrugs off the zombie!");
      } else {
        player.damage(2, "were bitten by a zombie");
        if (Game.toast) Game.toast("🧟 A zombie bit you! (-1 ❤️)");
      }
      u.hitCooldown = 1.2;
    }
  };

  // A skeleton roams the surface and, on a timer, looses an arrow off in a
  // RANDOM direction (not aimed at you).
  World.prototype.updateSkeleton = function (a, dt, player) {
    a.visible = true;
    const u = a.userData;
    u.timer -= dt;
    if (u.timer <= 0) { u.timer = 1.5 + Math.random() * 3; u.dir = Math.random() * Math.PI * 2; }
    this.wanderStep(a, dt, 0.9);

    // Fire an arrow off in a random direction if the player is roughly nearby.
    u.shootTimer -= dt;
    if (u.shootTimer <= 0) {
      u.shootTimer = 2 + Math.random() * 3;
      const dx = player.pos.x - a.position.x, dz = player.pos.z - a.position.z;
      if (dx * dx + dz * dz < 26 * 26) {
        const ang = Math.random() * Math.PI * 2;
        const dir = { x: Math.cos(ang), y: (Math.random() - 0.5) * 0.3, z: Math.sin(ang) };
        const len = Math.hypot(dir.x, dir.y, dir.z);
        this.spawnArrow({ x: a.position.x, y: a.position.y + 1.3, z: a.position.z },
          { x: dir.x / len, y: dir.y / len, z: dir.z / len });
      }
    }
  };

  World.prototype.spawnArrow = function (from, dir) {
    if (!this.arrows) this.arrows = [];
    const SPEED = 10;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.08, 0.08),
      new THREE.MeshLambertMaterial({ color: 0x7a6a55 })
    );
    mesh.position.set(from.x, from.y, from.z);
    // Point the shaft along its flight direction.
    mesh.rotation.y = Math.atan2(dir.x, dir.z);
    if (this.scene) this.scene.add(mesh);
    this.arrows.push({ mesh: mesh, vel: { x: dir.x * SPEED, y: dir.y * SPEED, z: dir.z * SPEED }, life: 4 });
  };

  World.prototype.updateArrows = function (dt, player) {
    if (!this.arrows || !this.arrows.length) return;
    const eye = player.eyePosition();
    const remove = (ar) => { if (this.scene) this.scene.remove(ar.mesh); if (ar.mesh.geometry) ar.mesh.geometry.dispose(); };
    this.arrows = this.arrows.filter((ar) => {
      const m = ar.mesh;
      m.position.x += ar.vel.x * dt;
      m.position.y += ar.vel.y * dt;
      m.position.z += ar.vel.z * dt;
      ar.life -= dt;
      const dx = m.position.x - eye.x, dy = m.position.y - eye.y, dz = m.position.z - eye.z;
      if (dx * dx + dy * dy + dz * dz < 0.7 * 0.7) {
        // A shield or any armour stops the arrow cold.
        if (Game.hasDefense && Game.hasDefense()) {
          if (Game.toast) Game.toast("🛡️ Your armour blocked the arrow!");
        } else {
          player.damage(2, "were shot by a skeleton");
          if (Game.toast) Game.toast("🏹 A skeleton's arrow hit you! (-1 ❤️)");
        }
        remove(ar); return false;
      }
      if (this.solidAt(Math.floor(m.position.x), Math.floor(m.position.y), Math.floor(m.position.z)) || ar.life <= 0) {
        remove(ar); return false;
      }
      return true;
    });
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
      if (g.userData.kind === "piglin") { this.updatePiglin(g, dt); continue; }
      if (g.userData.kind === "wither") { this.updateWither(g, dt, eye); continue; }
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

      // A ghast fires a single fireball per Nether visit, then goes quiet until
      // the player leaves and comes back (which resets hasFired).
      if (!u.hasFired) {
        u.fireTimer -= dt;
        if (u.fireTimer <= 0) {
          const dx = eye.x - g.position.x, dy = eye.y - g.position.y, dz = eye.z - g.position.z;
          const dist = Math.hypot(dx, dy, dz);
          if (dist < 22 && dist > 1.5) {
            this.spawnFireball(g.position, { x: dx / dist, y: dy / dist, z: dz / dist });
            u.hasFired = true;
          } else {
            u.fireTimer = 1 + Math.random() * 2; // player out of range — try again soon
          }
        }
      }
    }

    this.updateFireballs(dt, player);
    this.updateSkulls(dt, player);
  };

  // The Wither floats near its fortress home, bobbing gently, and on a timer
  // flings a wither skull off in a RANDOM direction (not aimed at you) whenever
  // the player is somewhere nearby. It has no legs, so it hovers rather than
  // walks; it stays tethered to its home so it guards the fortress.
  World.prototype.updateWither = function (a, dt, eye) {
    const FLOOR = 2, CEIL = 14;
    const u = a.userData;
    u.t += dt;
    u.timer -= dt;
    if (u.timer <= 0) { u.timer = 1.5 + Math.random() * 2.5; u.dir = Math.random() * Math.PI * 2; }
    if (u.turnPause > 0) u.turnPause -= dt;
    const speed = 1.0;
    const nx = a.position.x + Math.cos(u.dir) * speed * dt;
    const nz = a.position.z + Math.sin(u.dir) * speed * dt;
    const fx = Math.floor(nx), fz = Math.floor(nz);
    const dhx = nx - u.home.x, dhz = nz - u.home.z;
    const blocked = fx < 2 || fz < 2 || fx >= C.WORLD - 2 || fz >= C.WORLD - 2 ||
      this.solidAt(fx, Math.floor(a.position.y), fz) ||
      (dhx * dhx + dhz * dhz) > u.roam * u.roam;         // stay near home
    if (blocked) { turnWhenBlocked(u); }
    else { a.position.x = nx; a.position.z = nz; }
    // Hover with a gentle bob, kept clear of the floor and ceiling.
    a.position.y = u.baseY + Math.sin(u.t * 0.9) * 0.5;
    a.position.y = Math.max(FLOOR + 2.5, Math.min(CEIL - 1.5, a.position.y));
    a.rotation.y = Math.atan2(eye.x - a.position.x, eye.z - a.position.z); // face the player

    // Fling a skull in a random direction when the player is within range.
    u.skullTimer -= dt;
    if (u.skullTimer <= 0) {
      u.skullTimer = 2 + Math.random() * 2.5;
      const dx = eye.x - a.position.x, dz = eye.z - a.position.z;
      if (dx * dx + dz * dz < 20 * 20) {
        const ang = Math.random() * Math.PI * 2;
        const dir = { x: Math.cos(ang), y: (Math.random() - 0.5) * 0.5, z: Math.sin(ang) };
        const len = Math.hypot(dir.x, dir.y, dir.z);
        // A skull springs from one of the three heads (centre or a side).
        const headX = [0, -0.5, 0.5][Math.floor(Math.random() * 3)];
        this.spawnSkull({ x: a.position.x + headX, y: a.position.y + 0.3, z: a.position.z },
          { x: dir.x / len, y: dir.y / len, z: dir.z / len });
      }
    }
  };

  // A wither skull: a small dark cube that flies straight. If it reaches the
  // player it inflicts the wither effect (a slow drain that darkens the screen).
  World.prototype.spawnSkull = function (from, dir) {
    const SPEED = 7;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.32, 0.32),
      new THREE.MeshLambertMaterial({ color: 0x24242c, emissive: 0x140a1c })
    );
    mesh.position.set(from.x, from.y, from.z);
    if (this.scene) this.scene.add(mesh);
    this.skulls.push({ mesh: mesh, vel: { x: dir.x * SPEED, y: dir.y * SPEED, z: dir.z * SPEED }, life: 4 });
  };

  World.prototype.updateSkulls = function (dt, player) {
    if (!this.skulls) return;
    const eye = player.eyePosition();
    const remove = (sk) => { if (this.scene) this.scene.remove(sk.mesh); if (sk.mesh.geometry) sk.mesh.geometry.dispose(); };
    this.skulls = this.skulls.filter((sk) => {
      const m = sk.mesh;
      m.position.x += sk.vel.x * dt;
      m.position.y += sk.vel.y * dt;
      m.position.z += sk.vel.z * dt;
      m.rotation.x += dt * 5; m.rotation.y += dt * 4;
      sk.life -= dt;
      // Reached the player? Inflict the wither effect — unless armour stops it.
      const dx = m.position.x - eye.x, dy = m.position.y - eye.y, dz = m.position.z - eye.z;
      if (dx * dx + dy * dy + dz * dz < 0.8 * 0.8) {
        if (Game.hasDefense && Game.hasDefense()) {
          if (Game.toast) Game.toast("🛡️ Your armour blocked the wither skull!");
        } else {
          if (player.applyWither) player.applyWither();
          if (Game.toast) Game.toast("💀 A wither skull hit you! You're withering… 🖤");
        }
        remove(sk); return false;
      }
      if (this.solidAt(Math.floor(m.position.x), Math.floor(m.position.y), Math.floor(m.position.z)) || sk.life <= 0) {
        remove(sk); return false;
      }
      return true;
    });
  };

  // A piglin snuffles along the Nether floor, turning at walls, lava and edges.
  World.prototype.updatePiglin = function (a, dt) {
    const FLOOR = 2;
    const u = a.userData;
    u.timer -= dt;
    if (u.timer <= 0) { u.timer = 1.5 + Math.random() * 3; u.dir = Math.random() * Math.PI * 2; }
    if (u.turnPause > 0) u.turnPause -= dt;
    const speed = 0.8;
    const nx = a.position.x + Math.cos(u.dir) * speed * dt;
    const nz = a.position.z + Math.sin(u.dir) * speed * dt;
    const fx = Math.floor(nx), fz = Math.floor(nz);
    const blocked = fx < 2 || fz < 2 || fx >= C.WORLD - 2 || fz >= C.WORLD - 2 ||
      this.solidAt(fx, FLOOR + 1, fz) || this.get(fx, FLOOR, fz) === "lava";
    if (blocked) { turnWhenBlocked(u); }
    else { a.position.x = nx; a.position.z = nz; }
    a.position.y = FLOOR + 1;
    faceYaw(a, -u.dir + Math.PI / 2, dt);
  };

  // A fireball. Ghasts spit orange ones; the Ender Dragon breathes purple ones
  // (opts.purple), which is only a colour + message change — the damage is the
  // same two hearts, and armour blocks either.
  World.prototype.spawnFireball = function (from, dir, opts) {
    const purple = !!(opts && opts.purple);
    const SPEED = purple ? 8 : 9;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.3, 0.3),
      new THREE.MeshLambertMaterial(purple
        ? { color: 0xc23cff, emissive: 0x9b1fd6 }
        : { color: 0xff7a1a, emissive: 0xff4500 })
    );
    mesh.position.set(from.x, from.y, from.z);
    if (this.scene) this.scene.add(mesh);
    this.fireballs.push({ mesh: mesh, vel: { x: dir.x * SPEED, y: dir.y * SPEED, z: dir.z * SPEED }, life: 4, purple: purple });
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
      // Hit the player? Two hearts of damage — unless armour shields you.
      const dx = m.position.x - eye.x, dy = m.position.y - eye.y, dz = m.position.z - eye.z;
      if (dx * dx + dy * dy + dz * dz < 0.8 * 0.8) {
        if (Game.hasDefense && Game.hasDefense()) {
          if (Game.toast) Game.toast(fb.purple
            ? "🛡️ Your armour shrugs off the dragon's purple fire!"
            : "🛡️ Your armour blocked the fireball!");
        } else {
          player.damage(4, fb.purple ? "were scorched by the Ender Dragon's fire" : "were scorched by a ghast's fireball");
          if (Game.toast) Game.toast(fb.purple ? "🐉 The dragon's purple fire hit you! (-2 ❤️)" : "🔥 A ghast's fireball hit you! (-2 ❤️)");
        }
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
