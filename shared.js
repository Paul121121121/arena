// shared.js
// Loaded by BOTH the Node server and the browser.
// The server is the referee; the browser predicts its own movement so it feels
// instant. If the two used different physics they would drift apart and you
// would rubber-band. One file, one set of rules.

(function (exports) {

  // =====================================================================
  // Core tuning
  // =====================================================================
  const CONFIG = {
    TICK_HZ: 60,
    SNAPSHOT_HZ: 22,
    INTERP_MS: 100,

    PLAYER_RADIUS: 0.42,
    STAND_HEIGHT: 1.82,
    STAND_EYE: 1.66,
    CROUCH_HEIGHT: 1.28,
    CROUCH_EYE: 1.12,
    HEAD_FRACTION: 0.82,     // hits above this share of body height are headshots

    BASE_SPEED: 5.4,
    SPRINT_MUL: 1.52,
    CROUCH_MUL: 0.46,
    ADS_MUL: 0.48,
    ACCEL: 11.0,          // how hard you accelerate, as a multiple of top speed
    FRICTION: 9.0,
    AIR_ACCEL: 1.7,
    GRAVITY: 21.0,
    JUMP_SPEED: 6.9,
    STEP_HEIGHT: 0.55,       // how tall a ledge you can walk straight up

    MAX_HEALTH: 100,
    RESPAWN_MS: 4000,
    SPAWN_PROTECT_MS: 1500,

    MAX_PLAYERS: 12,
    SCORE_LIMIT: 40,
    ROUND_MS: 8 * 60 * 1000,
    INTERMISSION_MS: 12000,

    MAX_INPUT_DT: 0.05,
    TEAMS: { a: { name: 'Vanguard', color: 0xd8703c }, b: { name: 'Sable', color: 0x4a90c4 } }
  };

  // =====================================================================
  // Weapons
  // Damage falls off with distance. Spread grows while you hold the trigger
  // and shrinks when you stop. Aiming down sights tightens it hard.
  // =====================================================================
  const WEAPONS = [
    {
      id: 'rifle', name: 'AR-15', slot: 1, kind: 'primary',
      mag: 30, reserve: 120, rpm: 620, auto: true,
      body: 30, head: 112, limb: 21,
      falloffStart: 34, falloffEnd: 90, falloffMin: 0.55,
      spreadBase: 0.0032, spreadPerShot: 0.0085, spreadMax: 0.055, spreadRecover: 5.2,
      adsMul: 0.28, moveSpread: 0.022, airSpread: 0.09, crouchMul: 0.7,
      pellets: 1, reloadMs: 2350, drawMs: 620, range: 150,
      kickV: 0.0105, kickH: 0.0034, adsFov: 52, moveMul: 1.0
    },
    {
      id: 'smg', name: 'MP5-K', slot: 2, kind: 'primary',
      mag: 30, reserve: 180, rpm: 860, auto: true,
      body: 21, head: 66, limb: 15,
      falloffStart: 16, falloffEnd: 45, falloffMin: 0.45,
      spreadBase: 0.0055, spreadPerShot: 0.0072, spreadMax: 0.07, spreadRecover: 7.0,
      adsMul: 0.4, moveSpread: 0.012, airSpread: 0.07, crouchMul: 0.75,
      pellets: 1, reloadMs: 2050, drawMs: 480, range: 90,
      kickV: 0.0072, kickH: 0.0038, adsFov: 60, moveMul: 1.08
    },
    {
      id: 'dmr', name: 'M40 Scout', slot: 3, kind: 'primary',
      mag: 5, reserve: 40, rpm: 48, auto: false,
      body: 105, head: 250, limb: 62,
      falloffStart: 200, falloffEnd: 240, falloffMin: 1.0,
      spreadBase: 0.0016, spreadPerShot: 0.09, spreadMax: 0.16, spreadRecover: 2.4,
      adsMul: 0.02, moveSpread: 0.075, airSpread: 0.18, crouchMul: 0.5,
      pellets: 1, reloadMs: 3200, drawMs: 900, range: 220,
      kickV: 0.052, kickH: 0.006, adsFov: 16, moveMul: 0.88, scope: true
    },
    {
      id: 'shotgun', name: 'M870', slot: 4, kind: 'primary',
      mag: 7, reserve: 40, rpm: 72, auto: false,
      body: 13, head: 24, limb: 10,
      falloffStart: 7, falloffEnd: 24, falloffMin: 0.12,
      spreadBase: 0.048, spreadPerShot: 0.012, spreadMax: 0.09, spreadRecover: 3.0,
      adsMul: 0.62, moveSpread: 0.012, airSpread: 0.05, crouchMul: 0.85,
      pellets: 9, reloadMs: 3400, drawMs: 700, range: 45,
      kickV: 0.042, kickH: 0.009, adsFov: 62, moveMul: 0.95
    },
    {
      id: 'pistol', name: 'P226', slot: 5, kind: 'secondary',
      mag: 15, reserve: 75, rpm: 420, auto: false,
      body: 25, head: 78, limb: 18,
      falloffStart: 18, falloffEnd: 50, falloffMin: 0.5,
      spreadBase: 0.0042, spreadPerShot: 0.011, spreadMax: 0.06, spreadRecover: 6.5,
      adsMul: 0.34, moveSpread: 0.016, airSpread: 0.08, crouchMul: 0.75,
      pellets: 1, reloadMs: 1750, drawMs: 400, range: 70,
      kickV: 0.0135, kickH: 0.005, adsFov: 58, moveMul: 1.12
    }
  ];

  const WEAPON_BY_ID = {};
  WEAPONS.forEach(function (w, i) {
    w.fireMs = 60000 / w.rpm;
    w.index = i;
    WEAPON_BY_ID[w.id] = w;
  });

  // =====================================================================
  // The map. 96 x 96 metres. Two bases, open flanks you can actually
  // sprint down, and enough structures to break up sightlines.
  // Every box: x/z is the centre, y is the bottom, w/h/d is the size.
  // =====================================================================

  function buildMap() {
    const boxes = [];
    const S = 96, HALF = S / 2;

    function box(x, y, z, w, h, d, kind) {
      boxes.push({ x: x, y: y, z: z, w: w, h: h, d: d, k: kind || 'concrete' });
    }

    // --- Perimeter ---
    box(0, 0, -HALF, S, 8, 2, 'wall');
    box(0, 0, HALF, S, 8, 2, 'wall');
    box(-HALF, 0, 0, 2, 8, S, 'wall');
    box(HALF, 0, 0, 2, 8, S, 'wall');

    // --- A hollow building: four walls, doorway in the north and south ---
    function building(cx, cz, w, d, h, kind) {
      const t = 0.6, gap = 3.2;
      const seg = (w - gap) / 2;
      box(cx - (gap / 2 + seg / 2), 0, cz - d / 2, seg, h, t, kind);
      box(cx + (gap / 2 + seg / 2), 0, cz - d / 2, seg, h, t, kind);
      box(cx - (gap / 2 + seg / 2), 0, cz + d / 2, seg, h, t, kind);
      box(cx + (gap / 2 + seg / 2), 0, cz + d / 2, seg, h, t, kind);
      box(cx - w / 2, 0, cz, t, h, d, kind);
      box(cx + w / 2, 0, cz, t, h, d, kind);
      box(cx, h, cz, w, 0.4, d, kind);   // roof
    }

    // --- Steps, built from blocks low enough to walk straight up ---
    function stairs(x, z, dir, steps, w) {
      for (let i = 0; i < steps; i++) {
        const h = 0.5 * (i + 1);
        box(x + dir.x * i * 1.2, 0, z + dir.z * i * 1.2,
          dir.x ? 1.2 : w, h, dir.z ? 1.2 : w, 'metal');
      }
    }

    // --- Vanguard base (south) ---
    box(0, 0, -40, 26, 5, 0.8, 'wall');
    box(-14, 0, -34, 0.8, 5, 12, 'wall');
    box(14, 0, -34, 0.8, 5, 12, 'wall');
    building(-26, -34, 12, 10, 4, 'brick');
    building(26, -34, 12, 10, 4, 'brick');
    box(-7, 0, -28, 4, 1.4, 4, 'crate');
    box(7, 0, -28, 4, 1.4, 4, 'crate');

    // --- Sable base (north) ---
    box(0, 0, 40, 26, 5, 0.8, 'wall');
    box(-14, 0, 34, 0.8, 5, 12, 'wall');
    box(14, 0, 34, 0.8, 5, 12, 'wall');
    building(-26, 34, 12, 10, 4, 'brick');
    building(26, 34, 12, 10, 4, 'brick');
    box(-7, 0, 28, 4, 1.4, 4, 'crate');
    box(7, 0, 28, 4, 1.4, 4, 'crate');

    // --- Centre block, two storeys, the thing everyone fights over ---
    building(0, 0, 18, 14, 4.2, 'concrete');
    box(0, 4.6, 0, 8, 3.2, 6, 'concrete');
    stairs(-11.5, -5, { x: 0, z: 1 }, 8, 3);
    stairs(11.5, 5, { x: 0, z: -1 }, 8, 3);

    // --- Flank lanes: deliberately open, with spaced cover ---
    [[-38, -22], [-38, -8], [-38, 8], [-38, 22],
     [38, -22], [38, -8], [38, 8], [38, 22]].forEach(function (p, i) {
      box(p[0], 0, p[1], 5, i % 2 ? 2.4 : 1.5, 5, 'container');
    });

    box(-29, 0, -16, 2.6, 2.6, 12, 'container');
    box(-29, 0, 16, 2.6, 2.6, 12, 'container');
    box(29, 0, -16, 2.6, 2.6, 12, 'container');
    box(29, 0, 16, 2.6, 2.6, 12, 'container');
    box(-29, 2.6, 0, 2.6, 2.6, 10, 'container');
    box(29, 2.6, 0, 2.6, 2.6, 10, 'container');

    // --- Sniper towers on the flanks ---
    // `side` is which way the staircase runs: +1 means it climbs from the +X
    // side toward the tower.
    function tower(cx, cz, side) {
      box(cx, 0, cz, 6, 5.5, 6, 'concrete');
      box(cx, 5.5, cz, 6, 0.4, 6, 'metal');            // platform, walking surface at 5.9

      box(cx, 5.9, cz - 2.8, 6, 1.0, 0.4, 'metal');    // railings across the ends
      box(cx, 5.9, cz + 2.8, 6, 1.0, 0.4, 'metal');
      box(cx - side * 2.8, 5.9, cz, 0.4, 1.0, 6, 'metal');   // far side, solid

      // Near side: two lengths with a three-metre gap where the stairs arrive
      box(cx + side * 2.8, 5.9, cz - 2.25, 0.4, 1.0, 1.5, 'metal');
      box(cx + side * 2.8, 5.9, cz + 2.25, 0.4, 1.0, 1.5, 'metal');

      // Eleven steps climbing toward the tower. Two things matter here: they
      // must rise as they approach (the other way round, the bottom step is
      // five metres tall and nobody can get on), and the top step has to sit
      // under the platform edge rather than short of it - otherwise the
      // platform's underside acts as a wall and stops you one step below.
      stairs(cx + side * 15.0, cz, { x: -side, z: 0 }, 11, 2.4);
    }
    tower(-20, -14, 1);
    tower(20, 14, -1);

    // --- Scattered cover ---
    [[-16, 6], [-12, 15], [-8, 23], [10, -15], [16, -6], [8, -23],
     [-34, 0], [34, 0], [-18, 27], [18, -27], [0, -19], [0, 19],
     [-6, 11], [6, -11], [-31, -28], [31, 28], [13, 25], [-13, -25]
    ].forEach(function (p, i) {
      const t = i % 3;
      if (t === 0) box(p[0], 0, p[1], 2.4, 1.15, 2.4, 'crate');
      else if (t === 1) box(p[0], 0, p[1], 3.6, 1.0, 1.2, 'barrier');
      else box(p[0], 0, p[1], 1.4, 1.9, 1.4, 'barrel');
    });

    // --- Half-height walls to peek over ---
    box(-22, 0, 0, 0.6, 1.25, 14, 'barrier');
    box(22, 0, 0, 0.6, 1.25, 14, 'barrier');
    box(0, 0, -14, 16, 1.25, 0.6, 'barrier');
    box(0, 0, 14, 16, 1.25, 0.6, 'barrier');

    return {
      size: S,
      boxes: boxes,
      spawns: {
        a: [
          { x: -8, z: -36, yaw: Math.PI }, { x: 0, z: -36, yaw: Math.PI },
          { x: 8, z: -36, yaw: Math.PI }, { x: -22, z: -30, yaw: Math.PI },
          { x: 22, z: -30, yaw: Math.PI }, { x: -36, z: -34, yaw: Math.PI }
        ],
        b: [
          { x: -8, z: 36, yaw: 0 }, { x: 0, z: 36, yaw: 0 },
          { x: 8, z: 36, yaw: 0 }, { x: -22, z: 30, yaw: 0 },
          { x: 22, z: 30, yaw: 0 }, { x: 36, z: 34, yaw: 0 }
        ]
      }
    };
  }

  const MAP = buildMap();

  // =====================================================================
  // Player size - changes when crouched, which changes the hitbox too
  // =====================================================================
  function dims(crouched) {
    return crouched
      ? { h: CONFIG.CROUCH_HEIGHT, eye: CONFIG.CROUCH_EYE }
      : { h: CONFIG.STAND_HEIGHT, eye: CONFIG.STAND_EYE };
  }

  // =====================================================================
  // Physics
  // =====================================================================

  // tol is how far ABOVE your feet a surface can be and still count as ground.
  // While walking it is STEP_HEIGHT, which is what lets you climb steps and
  // kerbs without jumping. In the air it is almost nothing, so you cannot
  // float up the side of a crate.
  function groundHeight(x, z, feetY, tol) {
    const r = CONFIG.PLAYER_RADIUS;
    if (tol === undefined) tol = 0.1;
    let best = 0;
    for (let i = 0; i < MAP.boxes.length; i++) {
      const b = MAP.boxes[i];
      const top = b.y + b.h;
      if (feetY + tol < top) continue;
      if (x < b.x - b.w / 2 - r || x > b.x + b.w / 2 + r) continue;
      if (z < b.z - b.d / 2 - r || z > b.z + b.d / 2 + r) continue;
      if (top > best) best = top;
    }
    return best;
  }

  function resolveHorizontal(p, height) {
    const r = CONFIG.PLAYER_RADIUS;
    const head = p.y + height;
    for (let i = 0; i < MAP.boxes.length; i++) {
      const b = MAP.boxes[i];
      const top = b.y + b.h;
      if (top - p.y <= CONFIG.STEP_HEIGHT) continue;   // low enough to step onto
      if (p.y >= top - 0.02 || head <= b.y) continue;

      const minX = b.x - b.w / 2 - r, maxX = b.x + b.w / 2 + r;
      const minZ = b.z - b.d / 2 - r, maxZ = b.z + b.d / 2 + r;
      if (p.x <= minX || p.x >= maxX || p.z <= minZ || p.z >= maxZ) continue;

      const dxl = p.x - minX, dxr = maxX - p.x;
      const dzl = p.z - minZ, dzr = maxZ - p.z;
      const m = Math.min(dxl, dxr, dzl, dzr);
      if (m === dxl) { p.x = minX; if (p.vx > 0) p.vx = 0; }
      else if (m === dxr) { p.x = maxX; if (p.vx < 0) p.vx = 0; }
      else if (m === dzl) { p.z = minZ; if (p.vz > 0) p.vz = 0; }
      else { p.z = maxZ; if (p.vz < 0) p.vz = 0; }
    }
  }

  function canSprint(input) {
    return !!input.sprint && input.forward > 0.5 && !input.crouch && !input.ads;
  }

  function stepPlayer(p, input, dt, weapon) {
    if (dt > CONFIG.MAX_INPUT_DT) dt = CONFIG.MAX_INPUT_DT;
    if (dt <= 0) return;

    p.yaw = input.yaw;
    p.pitch = input.pitch;
    p.crouch = !!input.crouch;

    const d = dims(p.crouch);

    // Forward must match where the camera looks: yaw 0 faces -Z.
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    let wx = -input.forward * sin + input.right * cos;
    let wz = -input.forward * cos - input.right * sin;
    const len = Math.hypot(wx, wz);
    if (len > 1) { wx /= len; wz /= len; }

    let maxSpeed = CONFIG.BASE_SPEED * (weapon ? weapon.moveMul : 1);
    if (p.crouch) maxSpeed *= CONFIG.CROUCH_MUL;
    else if (canSprint(input)) maxSpeed *= CONFIG.SPRINT_MUL;
    if (input.ads && !p.crouch) maxSpeed *= CONFIG.ADS_MUL;

    const onGround = p.y <= groundHeight(p.x, p.z, p.y) + 0.03;

    // Accelerate only along the direction you are asking for, and only up to
    // the speed you are allowed. A plain "add force then clamp" caps out at
    // ACCEL/FRICTION instead, which quietly makes sprinting do nothing.
    function accelerate(accelCoeff, targetSpeed) {
      const current = p.vx * wx + p.vz * wz;      // speed already along wishdir
      const add = targetSpeed - current;
      if (add <= 0) return;
      let step = accelCoeff * dt * targetSpeed;
      if (step > add) step = add;
      p.vx += wx * step;
      p.vz += wz * step;
    }

    if (onGround) {
      const speed = Math.hypot(p.vx, p.vz);
      if (speed > 0.01) {
        const scale = Math.max(0, speed - speed * CONFIG.FRICTION * dt) / speed;
        p.vx *= scale; p.vz *= scale;
      } else { p.vx = 0; p.vz = 0; }

      accelerate(CONFIG.ACCEL, maxSpeed);

      if (input.jump && !p.crouch) p.vy = CONFIG.JUMP_SPEED;
    } else {
      accelerate(CONFIG.AIR_ACCEL, maxSpeed);
      const s = Math.hypot(p.vx, p.vz);
      const cap = maxSpeed * 1.35;
      if (s > cap) { p.vx = p.vx / s * cap; p.vz = p.vz / s * cap; }
    }

    p.vy -= CONFIG.GRAVITY * dt;

    p.x += p.vx * dt;
    p.z += p.vz * dt;
    resolveHorizontal(p, d.h);

    p.y += p.vy * dt;
    // Step up onto low ledges, but only if we were already on the ground and
    // are not moving upwards - otherwise you could climb walls by jumping.
    const tol = (onGround && p.vy <= 0) ? CONFIG.STEP_HEIGHT : 0.1;
    const g = groundHeight(p.x, p.z, p.y, tol);
    if (p.y <= g) { p.y = g; p.vy = 0; }

    const lim = MAP.size / 2 - 1.8;
    if (p.x < -lim) p.x = -lim;
    if (p.x > lim) p.x = lim;
    if (p.z < -lim) p.z = -lim;
    if (p.z > lim) p.z = lim;
    if (p.y < -20) { p.y = 0; p.vy = 0; }
  }

  // =====================================================================
  // Shooting
  // =====================================================================

  function dirFromAngles(yaw, pitch) {
    const cp = Math.cos(pitch);
    return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  }

  function rayBox(ox, oy, oz, dx, dy, dz, lo, hi) {
    let tmin = 0, tmax = Infinity;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (o[i] < lo[i] || o[i] > hi[i]) return null;
      } else {
        let t1 = (lo[i] - o[i]) / d[i], t2 = (hi[i] - o[i]) / d[i];
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
    }
    return tmin;
  }

  // Distance to the first piece of level geometry, plus what it is made of
  // and which way the surface faces - both used for the impact effect.
  function rayWall(ox, oy, oz, dx, dy, dz, maxRange) {
    let best = maxRange, kind = null, nx = 0, ny = 1, nz = 0;
    for (let i = 0; i < MAP.boxes.length; i++) {
      const b = MAP.boxes[i];
      const t = rayBox(ox, oy, oz, dx, dy, dz,
        [b.x - b.w / 2, b.y, b.z - b.d / 2],
        [b.x + b.w / 2, b.y + b.h, b.z + b.d / 2]);
      if (t !== null && t < best) {
        best = t; kind = b.k;
        const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
        const ex = Math.abs(px - b.x) / (b.w / 2);
        const ey = Math.abs(py - (b.y + b.h / 2)) / (b.h / 2);
        const ez = Math.abs(pz - b.z) / (b.d / 2);
        if (ex >= ey && ex >= ez) { nx = px > b.x ? 1 : -1; ny = 0; nz = 0; }
        else if (ey >= ez) { nx = 0; ny = py > b.y + b.h / 2 ? 1 : -1; nz = 0; }
        else { nx = 0; ny = 0; nz = pz > b.z ? 1 : -1; }
      }
    }
    return { t: best, kind: kind, nx: nx, ny: ny, nz: nz };
  }

  function rayPlayer(ox, oy, oz, dx, dy, dz, px, py, pz, crouched) {
    const r = CONFIG.PLAYER_RADIUS;
    const d = dims(crouched);
    const t = rayBox(ox, oy, oz, dx, dy, dz,
      [px - r, py, pz - r], [px + r, py + d.h, pz + r]);
    if (t === null) return null;
    const local = (oy + dy * t) - py;
    let zone = 'body';
    if (local >= d.h * CONFIG.HEAD_FRACTION) zone = 'head';
    else if (local <= d.h * 0.32) zone = 'limb';
    return { t: t, zone: zone };
  }

  // Damage drops off with distance, so a pistol at 60m is not a rifle.
  function damageAt(weapon, zone, dist) {
    const base = zone === 'head' ? weapon.head : zone === 'limb' ? weapon.limb : weapon.body;
    if (dist <= weapon.falloffStart) return base;
    if (dist >= weapon.falloffEnd) return base * weapon.falloffMin;
    const f = (dist - weapon.falloffStart) / (weapon.falloffEnd - weapon.falloffStart);
    return base * (1 - f * (1 - weapon.falloffMin));
  }

  // How wide the cone is right now, given what the shooter is doing
  function currentSpread(weapon, state) {
    let s = weapon.spreadBase + weapon.spreadPerShot * (state.consecutive || 0);
    if (s > weapon.spreadMax) s = weapon.spreadMax;
    const moving = Math.hypot(state.vx || 0, state.vz || 0);
    if (moving > 0.6) s += weapon.moveSpread * Math.min(1, moving / CONFIG.BASE_SPEED);
    if (!state.onGround) s += weapon.airSpread;
    if (state.crouch) s *= weapon.crouchMul;
    if (state.ads) s *= weapon.adsMul;
    return s;
  }

  // Split a list of players into two even teams, at random.
  // Used at the start of every match so the same people are not stuck
  // together forever. Fisher-Yates, then alternate down the shuffled list.
  function balancedShuffle(ids) {
    const a = ids.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    const out = {};
    for (let i = 0; i < a.length; i++) out[a[i]] = (i % 2 === 0) ? 'a' : 'b';
    return out;
  }

  exports.balancedShuffle = balancedShuffle;
  exports.CONFIG = CONFIG;
  exports.WEAPONS = WEAPONS;
  exports.WEAPON_BY_ID = WEAPON_BY_ID;
  exports.MAP = MAP;
  exports.dims = dims;
  exports.stepPlayer = stepPlayer;
  exports.groundHeight = groundHeight;
  exports.canSprint = canSprint;
  exports.dirFromAngles = dirFromAngles;
  exports.rayWall = rayWall;
  exports.rayPlayer = rayPlayer;
  exports.damageAt = damageAt;
  exports.currentSpread = currentSpread;

})(typeof module !== 'undefined' && module.exports ? module.exports : (window.Shared = {}));
