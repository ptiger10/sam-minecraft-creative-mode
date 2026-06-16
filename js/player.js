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

  // ---- Main update ----------------------------------------------
  Player.prototype.update = function (dt, input) {
    if (this.dead) return;

    // --- Look / turn ---
    if (input.turnLeft) this.yaw += C.TURN_SPEED * dt;
    if (input.turnRight) this.yaw -= C.TURN_SPEED * dt;
    if (input.lookYaw) this.yaw += input.lookYaw;
    if (input.lookPitch) this.pitch += input.lookPitch;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));

    // --- Horizontal movement (no inertia, like creative walking) ---
    let dx = 0, dz = 0;
    if (input.forward) {
      const f = this.forwardH();
      dx = f.x * C.MOVE_SPEED * dt;
      dz = f.z * C.MOVE_SPEED * dt;
    }

    // --- Jump + gravity ---
    if (input.jump && this.onGround) {
      this.vel.y = C.JUMP_V;
      this.onGround = false;
    }
    this.vel.y -= C.GRAVITY * dt;
    if (this.vel.y < -55) this.vel.y = -55; // terminal velocity
    let dy = this.vel.y * dt;

    // --- Resolve each axis separately against the voxels ---
    if (dx !== 0 && !this.collides(this.pos.x + dx, this.pos.y, this.pos.z)) this.pos.x += dx;
    if (dz !== 0 && !this.collides(this.pos.x, this.pos.y, this.pos.z + dz)) this.pos.z += dz;

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

    // Track the peak height of a fall for damage purposes.
    if (this.onGround) {
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
    this.dead = false;
    this.fallPeak = this.pos.y;
    this.syncCamera();
  };

  Game.Player = Player;

})(window.Game);
