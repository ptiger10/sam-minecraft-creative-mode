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
  function blockGeometry(id) {
    if (geomCache[id]) return geomCache[id];
    const def = Game.BlockDefs[id];
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
  }

  World.key = (x, y, z) => x + "," + y + "," + z;

  World.prototype.get = function (x, y, z) {
    return this.blocks.get(World.key(x, y, z)) || null;
  };

  // A cell counts as "occupied" only if a real block is there.
  World.prototype.occupied = function (x, y, z) {
    return this.blocks.has(World.key(x, y, z));
  };

  // Collision solidity: real blocks, the floor, and invisible world walls.
  World.prototype.solidAt = function (x, y, z) {
    if (y < 0) return true; // bedrock floor — you cannot fall through
    if (x < 0 || x >= C.WORLD || z < 0 || z >= C.WORLD) return true; // edge walls
    return this.occupied(x, y, z);
  };

  World.prototype.surfaceY = function (x, z) {
    for (let y = C.MAX_Y; y >= 0; y--) {
      if (this.occupied(x, y, z)) return y;
    }
    return 0;
  };

  // ---- Generation ------------------------------------------------
  World.prototype.generate = function () {
    const height = Game.makeHeight(this.seed);
    const desert = this.biome === "desert";

    for (let x = 0; x < C.WORLD; x++) {
      for (let z = 0; z < C.WORLD; z++) {
        const h = Math.max(2, Math.min(C.MAX_Y - 6, height(x, z)));
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === h) {
            id = desert ? "sand" : "grass";
          } else if (y >= h - 2) {
            id = desert ? "sand" : "dirt";
          } else {
            id = this.pickStone(x, y, z);
          }
          this.blocks.set(World.key(x, y, z), id);
        }
        // Vegetation sits on top of the surface block.
        this.maybeVegetation(x, z, h, desert);
      }
    }

    // Spawn the player on top of the centre column.
    const sx = Math.floor(C.WORLD / 2), sz = Math.floor(C.WORLD / 2);
    this.spawn = { x: sx + 0.5, y: this.surfaceY(sx, sz) + 1, z: sz + 0.5 };

    this.spawnAnimals(desert ? 3 : 4);
  };

  // Stone, or an ore — rarer + special ores appear deeper.
  World.prototype.pickStone = function (x, y, z) {
    const r = Game.hash(this.seed, x, y, z);
    const deep = y < 4; // closer to bedrock
    if (r < 0.010) return "coal_ore";
    if (r < 0.018) return "iron_ore";
    if (r < 0.024) return "gold_ore";
    if (r < 0.030) return "redstone_ore";
    if (deep && r < 0.034) return "diamond_ore";
    if (deep && r < 0.037) return "emerald_ore";
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
      else if (r > 0.985) this.placeTree(x, h + 1, z, true); // rare oasis apple tree
      return;
    }

    // Forest: lots of trees, ~1/3 of them bearing apples.
    if (r < 0.12) {
      const apple = Game.hash(this.seed ^ 0x1234, x, 1, z) < 0.4;
      this.placeTree(x, h + 1, z, apple);
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
          // Sprinkle apples on the edge of apple-tree canopies.
          let id = "leaves";
          if (apple && dist >= 2 && Game.hash(this.seed, lx, ly, lz) < 0.28) id = "apple";
          this.blocks.set(World.key(lx, ly, lz), id);
        }
      }
    }
    // a leaf cap on top
    if (!this.occupied(x, top + 1, z)) this.blocks.set(World.key(x, top + 1, z), "leaves");
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
  function makeAnimal(kind) {
    const group = new THREE.Group();
    const bodyCol = kind === "pig" ? 0xeaa1a8 : 0xe8e3d3;
    const headCol = kind === "pig" ? 0xe88f98 : 0xdcd6c4;
    const legCol = kind === "pig" ? 0xc77f86 : 0xb9b3a2;
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.5), mat(bodyCol));
    body.position.y = 0.55;
    group.add(body);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), mat(headCol));
    head.position.set(0.6, 0.7, 0);
    group.add(head);

    const snoutCol = kind === "pig" ? 0xd97f88 : headCol;
    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.25), mat(snoutCol));
    snout.position.set(0.85, 0.62, 0);
    group.add(snout);

    const legGeo = new THREE.BoxGeometry(0.18, 0.4, 0.18);
    const offs = [[0.3, 0.18], [0.3, -0.18], [-0.3, 0.18], [-0.3, -0.18]];
    offs.forEach((o) => {
      const leg = new THREE.Mesh(legGeo, mat(legCol));
      leg.position.set(o[0], 0.2, o[1]);
      group.add(leg);
    });
    group.userData.kind = kind;
    return group;
  }

  World.prototype.spawnAnimals = function (count) {
    const rng = Game.mulberry32(this.seed ^ 0xa11ce);
    for (let i = 0; i < count; i++) {
      const kind = rng() < 0.5 ? "pig" : "sheep";
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
  };

  World.prototype.updateAnimals = function (dt) {
    for (const a of this.animals) {
      a.userData.timer -= dt;
      if (a.userData.timer <= 0) {
        a.userData.timer = 1.5 + Math.random() * 3;
        a.userData.dir = Math.random() * Math.PI * 2;
      }
      const speed = 0.7;
      const nx = a.position.x + Math.cos(a.userData.dir) * speed * dt;
      const nz = a.position.z + Math.sin(a.userData.dir) * speed * dt;
      // stay inside the world
      if (nx > 2 && nx < C.WORLD - 2 && nz > 2 && nz < C.WORLD - 2) {
        a.position.x = nx; a.position.z = nz;
      } else {
        a.userData.dir += Math.PI; // turn around at the border
      }
      const sy = this.surfaceY(Math.floor(a.position.x), Math.floor(a.position.z)) + 1;
      a.position.y += (sy - a.position.y) * Math.min(1, dt * 8);
      a.rotation.y = -a.userData.dir + Math.PI / 2;
      // little bob when it just got "punched"
      if (a.userData.hop > 0) {
        a.userData.hop -= dt;
        a.position.y += Math.sin(a.userData.hop * 20) * 0.05;
      }
    }
  };

  // Expose the per-type cube geometry so the held-item viewmodel can reuse it.
  World.geometry = blockGeometry;

  Game.World = World;

})(window.Game);
