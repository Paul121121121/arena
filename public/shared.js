// shared.js
// Loaded by BOTH the Node server and the browser.
//
// The server is the referee; the browser predicts its own movement so it feels
// instant. If the two ran different physics they would drift apart and you
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

    BASE_SPEED: 5.6,
    SPRINT_MUL: 1.45,
    CROUCH_MUL: 0.46,
    ACCEL: 11.0,             // as a multiple of top speed
    FRICTION: 9.0,
    AIR_ACCEL: 2.2,          // generous, so double jumps can be steered
    GRAVITY: 21.0,
    JUMP_SPEED: 7.0,
    DOUBLE_JUMP_SPEED: 6.4,  // the second one is slightly weaker
    MAX_JUMPS: 2,
    STEP_HEIGHT: 0.55,

    MAX_HEALTH: 100,
    MAX_STAMINA: 100,
    STAMINA_REGEN: 22,           // per second, when not blocking
    RESPAWN_MS: 5000,
    SPAWN_PROTECT_MS: 2000,

    // Capture the flag
    CAPTURES_TO_WIN: 5,
    FLAG_PICKUP_RANGE: 1.8,
    FLAG_RETURN_MS: 25000,       // a dropped flag goes home after this
    CARRIER_SPEED_MUL: 0.92,     // carrying the flag slows you a little

    // Pickups
    PICKUP_RANGE: 2.0,
    WEAPON_RESPAWN_MS: 12000,
    MEDKIT_HEAL: 40,
    MEDKIT_RESPAWN_MS: 22000,

    MAX_PLAYERS: 6,              // 3 v 3
    ROUND_MS: 15 * 60 * 1000,
    INTERMISSION_MS: 12000,

    MAX_INPUT_DT: 0.05,
    TEAMS: {
      a: { name: 'Crimson', color: 0xb03a2e, cape: 'cape_red' },
      b: { name: 'Azure',   color: 0x2e6fb0, cape: 'cape_blue' }
    }
  };

  // =====================================================================
  // Weapons
  //
  // Everyone starts with fists. Everything else is picked up off a pedestal
  // with E, and replaces what you are holding. Health is 100, so the numbers
  // below are chosen to make fights last two to four exchanges - long enough
  // to react, short enough that being caught out still kills you.
  // =====================================================================
  const WEAPONS = [
    {
      id: 'fists', name: 'Fists', kind: 'melee', sprite: null,
      damage: 9, cooldownMs: 480, windupMs: 120, staminaCost: 8, reach: 2.2, arc: 0.55,
      moveMul: 1.12, headMul: 1.5,
      desc: 'Better than nothing. Just.'
    },
    {
      id: 'sword', name: 'Arming Sword', kind: 'melee', sprite: 'sword',
      damage: 34, cooldownMs: 720, windupMs: 220, staminaCost: 18, reach: 2.9, arc: 0.6,
      moveMul: 1.0, headMul: 1.6,
      desc: 'Three hits. Reliable. Quick to swing.'
    },
    {
      id: 'axe', name: 'War Axe', kind: 'melee', sprite: 'axe',
      damage: 52, cooldownMs: 1150, windupMs: 380, staminaCost: 32, reach: 2.7, arc: 0.5,
      moveMul: 0.93, headMul: 1.5,
      desc: 'Two hits if both land. Slow wind-up you can see coming.'
    },
    {
      id: 'spear', name: 'Spear', kind: 'melee', sprite: 'spear',
      damage: 30, cooldownMs: 850, windupMs: 260, staminaCost: 20, reach: 4.3, arc: 0.32,
      moveMul: 1.02, headMul: 1.7,
      desc: 'Outranges every other melee. Narrow, so it must be aimed.'
    },
    {
      id: 'bow', name: 'Recurve Bow', kind: 'ranged', sprite: 'bow',
      damage: 46, cooldownMs: 950, windupMs: 0, staminaCost: 0,
      speed: 58, drop: 7.5, headMul: 1.9, bodyRange: 120,
      moveMul: 0.97,
      desc: 'Fast to loose, arrows drop over distance. Infinite arrows.'
    },
    {
      id: 'crossbow', name: 'Crossbow', kind: 'ranged', sprite: 'crossbow',
      damage: 68, cooldownMs: 1900, windupMs: 0, staminaCost: 0,
      speed: 82, drop: 3.5, headMul: 1.8, bodyRange: 150,
      moveMul: 0.9,
      desc: 'Hits far harder and flies flatter. Long reload.'
    }
  ];

  const WEAPON_BY_ID = {};
  WEAPONS.forEach(function (w, i) { w.index = i; WEAPON_BY_ID[w.id] = w; });
  const FISTS = 0;

  // =====================================================================
  // The map: two castles either end of a field, 128 x 108 metres.
  // Each castle has three ways in - the main gate and a sallyport on each
  // flank - so neither side can be sealed off by three defenders.
  // =====================================================================

  function buildMap() {
    const boxes = [];
    const W = 128, D = 108;

    function box(x, y, z, w, h, d, kind) {
      boxes.push({ x: x, y: y, z: z, w: w, h: h, d: d, k: kind || 'stone' });
    }

    // A wall with a gap in the middle - the gap is the doorway.
    function wallWithGap(cx, cz, len, height, thick, gap, along, kind) {
      const seg = (len - gap) / 2;
      const off = gap / 2 + seg / 2;
      if (along === 'x') {
        box(cx - off, 0, cz, seg, height, thick, kind);
        box(cx + off, 0, cz, seg, height, thick, kind);
        box(cx, height - 0.6, cz, gap, 0.6, thick, kind);   // lintel over the door
      } else {
        box(cx, 0, cz - off, thick, height, seg, kind);
        box(cx, 0, cz + off, thick, height, seg, kind);
        box(cx, height - 0.6, cz, thick, 0.6, gap, kind);
      }
    }

    // Steps built from blocks low enough to walk up
    function steps(x, z, dir, count, width) {
      for (let i = 0; i < count; i++) {
        const h = 0.5 * (i + 1);
        box(x + dir.x * i * 1.2, 0, z + dir.z * i * 1.2,
          dir.x ? 1.2 : width, h, dir.z ? 1.2 : width, 'wood');
      }
    }

    // --- the world's edge ---
    box(0, 0, -D / 2, W, 10, 2, 'cliff');
    box(0, 0, D / 2, W, 10, 2, 'cliff');
    box(-W / 2, 0, 0, 2, 10, D, 'cliff');
    box(W / 2, 0, 0, 2, 10, D, 'cliff');

    // ---------------------------------------------------------------
    // A castle. `side` is -1 for the south keep, +1 for the north one.
    // ---------------------------------------------------------------
    function castle(side) {
      const z = side * 40;          // centre of the castle
      const front = side * -1;      // which way faces the field

      // Curtain wall: front has the gate, the flanks have sallyports
      wallWithGap(0, z + front * 13, 40, 6, 1.2, 6, 'x', 'stone');     // main gate
      wallWithGap(-20, z, 22, 6, 1.2, 4.5, 'z', 'stone');              // west sallyport
      wallWithGap(20, z, 22, 6, 1.2, 4.5, 'z', 'stone');               // east sallyport
      box(0, 0, z - front * 13, 40, 6, 1.2, 'stone');                  // rear wall, solid

      // Corner towers
      [[-20, -13], [20, -13], [-20, 13], [20, 13]].forEach(function (c) {
        box(c[0], 0, z + front * c[1], 6, 9, 6, 'stone');
        box(c[0], 9, z + front * c[1], 7, 0.6, 7, 'stone');
      });

      // The keep, with the flag inside. Two doors so it cannot be camped
      // from a single angle.
      wallWithGap(0, z, 16, 5, 1.0, 4.5, 'x', 'stone');                // keep front
      box(0, 0, z - front * 6, 16, 5, 1.0, 'stone');                   // keep rear
      wallWithGap(-8, z - front * 3, 12, 5, 1.0, 3.5, 'z', 'stone');   // keep side door
      box(8, 0, z - front * 3, 1.0, 5, 12, 'stone');                   // other side solid
      box(0, 5, z - front * 3, 17, 0.6, 13, 'wood');                   // keep roof

      // Crates in the courtyard for cover
      box(-11, 0, z + front * 7, 2.4, 1.2, 2.4, 'crate');
      box(11, 0, z + front * 7, 2.4, 1.2, 2.4, 'crate');

      // Ramp onto the wall walk, so defenders can shoot down
      steps(-24, z + front * 8, { x: 1, z: 0 }, 10, 3);
    }

    castle(-1);
    castle(1);

    // ---------------------------------------------------------------
    // The field between them
    // ---------------------------------------------------------------

    // Central ruin - the thing both teams fight over on the way through
    wallWithGap(0, -6, 18, 4, 1.0, 5, 'x', 'ruin');
    wallWithGap(0, 6, 18, 4, 1.0, 5, 'x', 'ruin');
    box(-9, 0, 0, 1.0, 4, 12, 'ruin');
    box(9, 0, 0, 1.0, 4, 12, 'ruin');
    box(0, 4, 0, 19, 0.6, 13, 'wood');
    steps(-13, 0, { x: 1, z: 0 }, 8, 3);

    // Flanking routes: low walls that break the sightline down each side
    [-34, 34].forEach(function (x) {
      box(x, 0, -18, 3, 2.6, 10, 'ruin');
      box(x, 0, 18, 3, 2.6, 10, 'ruin');
      box(x, 0, 0, 3, 1.3, 8, 'ruin');
    });

    // Scattered cover so the open ground is not a shooting gallery
    [[-22, -8], [22, 8], [-16, 14], [16, -14], [-28, 2], [28, -2],
     [-6, -20], [6, 20], [-44, -6], [44, 6], [-40, 22], [40, -22]
    ].forEach(function (p, i) {
      if (i % 3 === 0) box(p[0], 0, p[1], 2.4, 1.25, 2.4, 'crate');
      else if (i % 3 === 1) box(p[0], 0, p[1], 1.6, 2.4, 1.6, 'barrel');
      else box(p[0], 0, p[1], 4, 1.1, 1.2, 'fence');
    });

    return {
      size: Math.max(W, D), width: W, depth: D,
      boxes: boxes,

      // Flag stands, deep inside each keep
      flags: {
        a: { x: 0, z: -43 },
        b: { x: 0, z: 43 }
      },

      spawns: {
        a: [
          { x: -6, z: -46, yaw: 0 }, { x: 0, z: -46, yaw: 0 }, { x: 6, z: -46, yaw: 0 },
          { x: -14, z: -44, yaw: 0 }, { x: 14, z: -44, yaw: 0 }
        ],
        b: [
          { x: -6, z: 46, yaw: Math.PI }, { x: 0, z: 46, yaw: Math.PI }, { x: 6, z: 46, yaw: Math.PI },
          { x: -14, z: 44, yaw: Math.PI }, { x: 14, z: 44, yaw: Math.PI }
        ]
      },

      // Weapon pedestals. Deliberately placed so the strong, slow weapons
      // sit out in the open and the quick ones are nearer to cover.
      pedestals: [
        { id: 'sword',    x: -30, z: -22 },
        { id: 'sword',    x: 30,  z: 22 },
        { id: 'spear',    x: 30,  z: -22 },
        { id: 'spear',    x: -30, z: 22 },
        { id: 'bow',      x: -13, z: 0 },
        { id: 'bow',      x: 13,  z: 0 },
        { id: 'axe',      x: 0,   z: 0 },      // middle of the ruin, contested
        { id: 'crossbow', x: -44, z: 0 },
        { id: 'crossbow', x: 44,  z: 0 }
      ],

      // Where medkits can appear. One is live at a time per slot; after it is
      // taken it comes back somewhere else on this list.
      medkitSpots: [
        { x: -22, z: -30 }, { x: 22, z: -30 }, { x: -22, z: 30 }, { x: 22, z: 30 },
        { x: -38, z: -12 }, { x: 38, z: 12 }, { x: -38, z: 12 }, { x: 38, z: -12 },
        { x: 0, z: -20 }, { x: 0, z: 20 }, { x: -8, z: 8 }, { x: 8, z: -8 }
      ]
    };
  }

  const MAP = buildMap();

  // =====================================================================
  // Player size
  // =====================================================================
  function dims(crouched) {
    return crouched
      ? { h: CONFIG.CROUCH_HEIGHT, eye: CONFIG.CROUCH_EYE }
      : { h: CONFIG.STAND_HEIGHT, eye: CONFIG.STAND_EYE };
  }

  // =====================================================================
  // Physics
  // =====================================================================

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
      if (top - p.y <= CONFIG.STEP_HEIGHT) continue;      // walk straight up it
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
    return !!input.sprint && input.forward > 0.5 && !input.crouch;
  }

  function stepPlayer(p, input, dt, weapon, carryingFlag) {
    if (dt > CONFIG.MAX_INPUT_DT) dt = CONFIG.MAX_INPUT_DT;
    if (dt <= 0) return;

    p.yaw = input.yaw;
    p.pitch = input.pitch;
    p.crouch = !!input.crouch;

    const d = dims(p.crouch);
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    let wx = -input.forward * sin + input.right * cos;
    let wz = -input.forward * cos - input.right * sin;
    const len = Math.hypot(wx, wz);
    if (len > 1) { wx /= len; wz /= len; }

    let maxSpeed = CONFIG.BASE_SPEED * (weapon ? weapon.moveMul : 1);
    if (p.crouch) maxSpeed *= CONFIG.CROUCH_MUL;
    else if (canSprint(input)) maxSpeed *= CONFIG.SPRINT_MUL;
    if (carryingFlag) maxSpeed *= CONFIG.CARRIER_SPEED_MUL;

    const onGround = p.y <= groundHeight(p.x, p.z, p.y) + 0.03;
    if (onGround && p.vy <= 0.01) p.jumps = 0;

    // Only add speed along the direction asked for, up to the cap. A plain
    // "add force then clamp" tops out at ACCEL/FRICTION instead, which
    // quietly makes sprinting do nothing.
    function accelerate(coeff, target) {
      const current = p.vx * wx + p.vz * wz;
      const add = target - current;
      if (add <= 0) return;
      let step = coeff * dt * target;
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
    } else {
      accelerate(CONFIG.AIR_ACCEL, maxSpeed);
      const s = Math.hypot(p.vx, p.vz);
      const cap = maxSpeed * 1.4;
      if (s > cap) { p.vx = p.vx / s * cap; p.vz = p.vz / s * cap; }
    }

    // Jumping. `jumpEdge` is set by the client only on the frame the key goes
    // down, so holding space does not spend both jumps at once.
    if (input.jumpEdge && p.jumps < CONFIG.MAX_JUMPS && !p.crouch) {
      p.vy = p.jumps === 0 ? CONFIG.JUMP_SPEED : CONFIG.DOUBLE_JUMP_SPEED;
      p.jumps++;
    }

    p.vy -= CONFIG.GRAVITY * dt;

    p.x += p.vx * dt;
    p.z += p.vz * dt;
    resolveHorizontal(p, d.h);

    p.y += p.vy * dt;
    const tol = (onGround && p.vy <= 0) ? CONFIG.STEP_HEIGHT : 0.1;
    const g = groundHeight(p.x, p.z, p.y, tol);
    if (p.y <= g) { p.y = g; p.vy = 0; p.jumps = 0; }

    const lx = MAP.width / 2 - 1.8, lz = MAP.depth / 2 - 1.8;
    if (p.x < -lx) p.x = -lx;
    if (p.x > lx) p.x = lx;
    if (p.z < -lz) p.z = -lz;
    if (p.z > lz) p.z = lz;
    if (p.y < -20) { p.y = 0; p.vy = 0; }
  }

  // =====================================================================
  // Aiming and hit tests
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
    return { t: t, head: local >= d.h * 0.82 };
  }

  // Melee: a short cone in front of you rather than a single ray, so a swing
  // that is roughly on target connects. `arc` is the half-angle in radians.
  function meleeHits(attacker, weapon, targets) {
    const d = dims(attacker.crouch);
    const ex = attacker.x, ey = attacker.y + d.eye, ez = attacker.z;
    const aim = dirFromAngles(attacker.yaw, attacker.pitch);
    const hits = [];

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const td = dims(t.crouch);
      const cx = t.x - ex;
      const cy = (t.y + td.h * 0.5) - ey;
      const cz = t.z - ez;
      const dist = Math.hypot(cx, cy, cz);
      if (dist > weapon.reach + CONFIG.PLAYER_RADIUS) continue;
      if (dist < 0.001) { hits.push({ target: t, dist: dist, head: false }); continue; }

      const dot = (cx * aim.x + cy * aim.y + cz * aim.z) / dist;
      if (dot < Math.cos(weapon.arc)) continue;          // outside the swing

      // Do not swing through walls
      const wall = rayWall(ex, ey, ez, cx / dist, cy / dist, cz / dist, dist);
      if (wall.t < dist - 0.4) continue;

      const head = (t.y + td.h * 0.82) < ey + 0.35 && (t.y + td.h) > ey - 0.2;
      hits.push({ target: t, dist: dist, head: head });
    }
    return hits;
  }

  // =====================================================================
  // Arrows and bolts. These are real objects that fly and drop, not instant
  // rays - which is what makes leading a moving target matter.
  // =====================================================================

  function stepProjectile(pr, dt) {
    pr.vy -= (pr.drop || 0) * dt;
    pr.px = pr.x; pr.py = pr.y; pr.pz = pr.z;
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.z += pr.vz * dt;
    pr.life -= dt;
  }

  // Did the projectile's travel this tick cross anything?
  function projectileHit(pr, targets) {
    const dx = pr.x - pr.px, dy = pr.y - pr.py, dz = pr.z - pr.pz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return null;
    const ux = dx / dist, uy = dy / dist, uz = dz / dist;

    const wall = rayWall(pr.px, pr.py, pr.pz, ux, uy, uz, dist);

    let best = null;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const r = rayPlayer(pr.px, pr.py, pr.pz, ux, uy, uz, t.x, t.y, t.z, t.crouch);
      if (r && r.t <= dist && (!best || r.t < best.t)) {
        best = { t: r.t, head: r.head, target: t };
      }
    }

    if (best && best.t < wall.t) {
      return { kind: 'player', target: best.target, head: best.head,
               x: pr.px + ux * best.t, y: pr.py + uy * best.t, z: pr.pz + uz * best.t };
    }
    if (wall.t < dist) {
      return { kind: 'wall', surface: wall.kind,
               x: pr.px + ux * wall.t, y: pr.py + uy * wall.t, z: pr.pz + uz * wall.t,
               nx: wall.nx, ny: wall.ny, nz: wall.nz };
    }
    return null;
  }

  // Split a list of players into two even teams at random. Used at the start
  // of every match so the same people are not stuck together forever.
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

  exports.CONFIG = CONFIG;
  exports.WEAPONS = WEAPONS;
  exports.WEAPON_BY_ID = WEAPON_BY_ID;
  exports.FISTS = FISTS;
  exports.MAP = MAP;
  exports.dims = dims;
  exports.stepPlayer = stepPlayer;
  exports.groundHeight = groundHeight;
  exports.canSprint = canSprint;
  exports.dirFromAngles = dirFromAngles;
  exports.rayWall = rayWall;
  exports.rayPlayer = rayPlayer;
  exports.meleeHits = meleeHits;
  exports.stepProjectile = stepProjectile;
  exports.projectileHit = projectileHit;
  exports.balancedShuffle = balancedShuffle;

})(typeof module !== 'undefined' && module.exports ? module.exports : (window.Shared = {}));
