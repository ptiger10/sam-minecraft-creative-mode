/* ===========================================================
   player.js — the (blocky) player: movement, collisions with
   the voxel world, the first-person camera, jumping, fall
   damage, and the health / food (hunger) system.
   =========================================================== */

(function (Game) {
  "use strict";

  const C = Game.CONST;

  function Player(camera, world) {
    this.camera = camera;
    this.world = world;
    this.pos = new THREE.Vector3(world.spawn.x, world.spawn.y, world.spawn.z);
    this.vel = new THREE.Vector3(0, 0, 0);
    this.yaw = 0;
    this.pitch = -0.35;          // start looking down a bit (so flat ground is in reach)
    this.onGround = false;
    this.fallPeak = this.pos.y;  // highest point of the current fall

    this.hp = C.MAX_HP;
    this.food = C.MAX_FOOD;
    this.foodTimer = 0;
    this.starveTimer = 0;
    this.regenTimer = 0;
    this.air = C.MAX_AIR;        // breath remaining while underwater
    this.drownTimer = 0;
    this.wither = 0;             // seconds of wither effect remaining
    this.witherDmgTimer = 0;     // counts up to the next wither heart loss
    this.dead = false;

    camera.rotation.order = "YXZ";
    this.syncCamera();
  }

  // Horizontal "forward" vector (ignores pitch) used for walking.
  Player.prototype.forwardH = function () {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  };

  // Full look direction (yaw + pitch) used for aiming/raycasting.
  Player.prototype.lookDir = function () {
    const e = new THREE.Euler(this.pitch, this.yaw, 0, "YXZ");
    return new THREE.Vector3(0, 0, -1).applyEuler(e);
  };

  Player.prototype.eyePosition = function () {
    return new THREE.Vector3(this.pos.x, this.pos.y + C.EYE, this.pos.z);
  };

  Player.prototype.syncCamera = function () {
    this.camera.position.copy(this.eyePosition());
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  };

  // ---- Water -----------------------------------------------------
  Player.prototype.blockAt = function (x, y, z) {
    return this.world.get(Math.floor(x), Math.floor(y), Math.floor(z));
  };
  // Is there water at height y in the column the player is standing in?
  Player.prototype.inWaterAt = function (y) {
    return this.blockAt(this.pos.x, y, this.pos.z) === "water";
  };

  // ---- Collision ------------------------------------------------
  // Does the player's box overlap any solid block at this position?
  Player.prototype.collides = function (px, py, pz) {
    const h = C.P_HALF;
    const minX = Math.floor(px - h), maxX = Math.floor(px + h);
    const minY = Math.floor(py), maxY = Math.floor(py + C.P_HEIGHT - 0.001);
    const minZ = Math.floor(pz - h), maxZ = Math.floor(pz + h);
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++)
        for (let z = minZ; z <= maxZ; z++)
          if (this.world.solidAt(x, y, z)) return true;
    return false;
  };

  // ---- Stairs (auto step-up) ------------------------------------
  // Is there a stairs block in the footprint at this spot, at foot height?
  Player.prototype.stairAt = function (x, z) {
    const h = C.P_HALF;
    const y = Math.floor(this.pos.y);
    for (let cx = Math.floor(x - h); cx <= Math.floor(x + h); cx++)
      for (let cz = Math.floor(z - h); cz <= Math.floor(z + h); cz++)
        if (this.world.get(cx, y, cz) === "stairs") return true;
    return false;
  };

  // Move along one axis. If the way is clear, just slide. If a STAIRS block is
  // blocking and there's headroom above it, step up onto it — so a flight of
  // stairs is walked up smoothly, no jumping required. (Walking back down is
  // just gravity over a single, harmless block-high drop.)
  Player.prototype.stepMove = function (dx, dz, grounded) {
    if (dx === 0 && dz === 0) return;
    const nx = this.pos.x + dx, nz = this.pos.z + dz;
    if (!this.collides(nx, this.pos.y, nz)) {
      this.pos.x = nx; this.pos.z = nz;
      return;
    }
    // Blocked. Only stairs let you step up, and only while you're on the ground.
    if (!grounded) return;
    if (!this.stairAt(nx, nz)) return;
    const step = C.STEP_HEIGHT;
    if (this.collides(this.pos.x, this.pos.y + step, this.pos.z)) return; // can't rise here
    if (this.collides(nx, this.pos.y + step, nz)) return;                 // no room up there
    this.pos.x = nx; this.pos.z = nz; this.pos.y += step;
    this.onGround = true; this.vel.y = 0;
  };

  // ---- Ladders ---------------------------------------------------
  // You're "on a ladder" when one sits in the cell directly in front of you
  // (the way you're facing), at any height your body spans. Climbing then
  // replaces gravity: hold forward (or jump) to go up, let go to slide down.
  Player.prototype.ladderInFront = function () {
    const f = this.forwardH(); // unit horizontal vector from the yaw
    const ax = Math.floor(this.pos.x + f.x * (C.P_HALF + 0.25));
    const az = Math.floor(this.pos.z + f.z * (C.P_HALF + 0.25));
    const minY = Math.floor(this.pos.y);
    const maxY = Math.floor(this.pos.y + C.P_HEIGHT - 0.001);
    for (let y = minY; y <= maxY; y++) {
      if (this.world.get(ax, y, az) === "ladder") return true;
    }
    return false;
  };

  // ---- Main update ----------------------------------------------
  Player.prototype.update = function (dt, input) {
    if (this.dead) return;

    // --- Look / turn ---
    if (input.turnLeft) this.yaw += C.TURN_SPEED * dt;
    if (input.turnRight) this.yaw -= C.TURN_SPEED * dt;
    if (input.lookYaw) this.yaw += input.lookYaw;
    if (input.lookPitch) this.pitch += input.lookPitch;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));

    // --- Are we in water? (drives swimming, buoyancy and no fall damage) ---
    const feetWater = this.inWaterAt(this.pos.y + 0.1);
    const bodyWater = this.inWaterAt(this.pos.y + 0.9);
    const swimming = feetWater || bodyWater;
    if (swimming) this.fallPeak = this.pos.y; // splashing into water never hurts

    // --- Horizontal movement (a little slower while swimming) ---
    let dx = 0, dz = 0;
    if (input.forward) {
      const f = this.forwardH();
      const sp = swimming ? C.MOVE_SPEED * 0.65 : C.MOVE_SPEED;
      dx = f.x * sp * dt;
      dz = f.z * sp * dt;
    }

    // --- Climbing, swimming, or jump + gravity ---
    const climbing = this.ladderInFront();
    if (climbing) {
      // Hold forward (push into it) or jump to go up; otherwise slide gently
      // down. No gravity build-up while you're on the rungs.
      this.vel.y = (input.forward || input.jump) ? C.CLIMB_SPEED : -C.CLIMB_SPEED * 0.5;
    } else if (swimming) {
      if (input.jump) {
        this.vel.y = C.SWIM_UP;              // press jump to rise to the surface
      } else {
        // No jump: you sink. Reduced gravity pulls you down and water drag
        // settles you to a slow, steady sink — so hold jump to come back up.
        this.vel.y -= C.GRAVITY * 0.25 * dt;
        this.vel.y -= this.vel.y * 3 * dt;    // water drag (frame-rate independent)
        if (this.vel.y < -C.SWIM_SINK) this.vel.y = -C.SWIM_SINK;
        if (this.vel.y > C.SWIM_UP) this.vel.y = C.SWIM_UP;
      }
    } else {
      if (input.jump && this.onGround) {
        this.vel.y = C.JUMP_V;
        this.onGround = false;
      }
      this.vel.y -= C.GRAVITY * dt;
      if (this.vel.y < -55) this.vel.y = -55; // terminal velocity
    }
    let dy = this.vel.y * dt;

    // --- Resolve each axis separately against the voxels ---
    // (auto-stepping up onto stairs so you can walk up them without jumping)
    const grounded = this.onGround;
    this.stepMove(dx, 0, grounded);
    this.stepMove(0, dz, grounded);

    const wasGround = this.onGround;
    this.onGround = false;
    if (!this.collides(this.pos.x, this.pos.y + dy, this.pos.z)) {
      this.pos.y += dy;
    } else {
      if (this.vel.y < 0) {
        // landed
        this.onGround = true;
        this.handleLanding();
      }
      this.vel.y = 0;
    }

    // Track the peak height of a fall for damage purposes. Climbing and being
    // in water never hurt, so they keep the peak pinned to where you are.
    if (this.onGround || climbing || swimming) {
      this.fallPeak = this.pos.y;
    } else if (this.pos.y > this.fallPeak) {
      this.fallPeak = this.pos.y;
    }
    // Re-check ground contact for the next jump (small probe below feet).
    if (!this.onGround && this.collides(this.pos.x, this.pos.y - 0.06, this.pos.z) && this.vel.y <= 0) {
      this.onGround = true;
    }

    this.updateVitals(dt);
    this.syncCamera();
  };

  Player.prototype.handleLanding = function () {
    const dist = this.fallPeak - this.pos.y;
    if (dist > C.FALL_SAFE) {
      const dmg = Math.floor(dist - C.FALL_SAFE);
      if (dmg > 0) this.damage(dmg, "fell from too high");
    }
    this.fallPeak = this.pos.y;
  };

  // ---- Health & food --------------------------------------------
  Player.prototype.updateVitals = function (dt) {
    // Hunger slowly drains over time (gently — a quarter of the old rate).
    this.foodTimer += dt;
    if (this.foodTimer >= C.FOOD_DRAIN) {
      this.foodTimer = 0;
      if (this.food > 0) this.food -= 1;
    }

    if (this.food <= 0) {
      // Starving — lose health.
      this.starveTimer += dt;
      if (this.starveTimer >= 3) {
        this.starveTimer = 0;
        this.damage(1, "starved");
      }
    } else {
      this.starveTimer = 0;
      // Well fed — slowly regenerate health.
      if (this.food >= 16 && this.hp < C.MAX_HP) {
        this.regenTimer += dt;
        if (this.regenTimer >= 4) { this.regenTimer = 0; this.hp = Math.min(C.MAX_HP, this.hp + 1); }
      }
    }

    // Breath: while your head is underwater your air runs down; once it's gone
    // you start losing health, so come up for air. Air refills quickly above
    // the surface.
    const submerged = this.inWaterAt(this.pos.y + C.EYE - 0.1);
    if (submerged) {
      this.air -= dt;
      if (this.air <= 0) {
        this.air = 0;
        this.drownTimer += dt;
        if (this.drownTimer >= 1.5) { this.drownTimer = 0; this.damage(1, "drowned"); }
      }
    } else if (this.air < C.MAX_AIR) {
      this.air = Math.min(C.MAX_AIR, this.air + dt * 4);
      this.drownTimer = 0;
    }

    // Wither: a wither skull's poison drains a heart every ~3 seconds until it
    // wears off after 6 seconds. The screen tint is driven from the game loop.
    if (this.wither > 0) {
      this.wither -= dt;
      this.witherDmgTimer += dt;
      if (this.witherDmgTimer >= 3) { this.witherDmgTimer -= 3; this.damage(2, "withered away"); }
      if (this.wither <= 0) { this.wither = 0; this.witherDmgTimer = 0; }
    }
  };

  Player.prototype.damage = function (amount, reason) {
    if (this.dead) return;
    this.hp -= amount;
    this.lastDamage = reason;
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
    }
  };

  Player.prototype.eat = function (foodValue) {
    this.food = Math.min(C.MAX_FOOD, this.food + foodValue);
  };

  Player.prototype.respawn = function () {
    this.pos.set(this.world.spawn.x, this.world.spawn.y, this.world.spawn.z);
    this.vel.set(0, 0, 0);
    this.hp = C.MAX_HP;
    this.food = C.MAX_FOOD;
    this.foodTimer = 0;
    this.starveTimer = 0;
    this.air = C.MAX_AIR;
    this.drownTimer = 0;
    this.wither = 0;
    this.witherDmgTimer = 0;
    this.dead = false;
    this.fallPeak = this.pos.y;
    this.syncCamera();
  };

  // Start (or refresh) the wither effect: it lasts 6 seconds and drains one
  // heart (2 HP) about every 3 seconds. Getting hit again tops the timer back up.
  Player.prototype.applyWither = function () {
    if (this.wither <= 0) this.witherDmgTimer = 0; // fresh case: start the clock
    this.wither = 6;
  };

  Game.Player = Player;

})(window.Game);
