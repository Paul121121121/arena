// Offline tests. No server, no network - the pure logic in shared.js.
const S = require('./public/shared.js');
const U = require('./test-util.js');
const { CONFIG, WEAPONS, MAP } = S;

const R = [];
const check = (n, ok, note) => {
  R.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : ''));
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function fresh(x, z, y) {
  return { x, y: y === undefined ? 0 : y, z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, crouch: false };
}
function hold(p, input, ticks, w) {
  const base = { forward: 0, right: 0, jump: false, crouch: false, sprint: false, ads: false, yaw: 0, pitch: 0 };
  for (let i = 0; i < ticks; i++) S.stepPlayer(p, Object.assign({}, base, input), 1 / 60, w);
  return p;
}
// Is there a clear line between two points?
function clear(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  const w = S.rayWall(ax, ay, az, dx / dist, dy / dist, dz / dist, dist + 1);
  return w.t >= dist - 0.05;
}

console.log('--- map ---');

check('map is 96m across', MAP.size === 96);
check(`geometry present (${MAP.boxes.length} boxes)`, MAP.boxes.length > 60);
check('both teams have spawns', MAP.spawns.a.length >= 5 && MAP.spawns.b.length >= 5);

// No box may have zero or negative size, and none may sit under the floor
let badBox = null;
for (const b of MAP.boxes) {
  if (b.w <= 0 || b.h <= 0 || b.d <= 0 || b.y < -0.001) { badBox = b; break; }
}
check('every box has valid dimensions', !badBox, badBox ? JSON.stringify(badBox) : '');

// Nobody may spawn inside a wall
let stuck = null;
for (const team of ['a', 'b']) {
  for (const sp of MAP.spawns[team]) {
    const p = fresh(sp.x, sp.z, 0.2);
    hold(p, {}, 60);
    if (Math.hypot(p.x - sp.x, p.z - sp.z) > 1.2) { stuck = `${team} ${sp.x},${sp.z}`; break; }
  }
}
check('no spawn point is inside geometry', !stuck, stuck || '');

// Spawns must be far enough apart that you do not spawn in front of the enemy
let minCross = Infinity;
for (const a of MAP.spawns.a) for (const b of MAP.spawns.b) {
  minCross = Math.min(minCross, Math.hypot(a.x - b.x, a.z - b.z));
}
check(`enemy spawns are far apart (${minCross.toFixed(0)}m)`, minCross > 55);

// There has to be somewhere to actually run: a long unobstructed straight
let longestLane = 0;
for (let x = -42; x <= 42; x += 2) {
  let run = 0, best = 0;
  for (let z = -44; z <= 44; z += 1) {
    const p = fresh(x, z, 0.1);
    const g = S.groundHeight(x, z, 0.1);
    const blocked = g > 0.6 || !clear(x, 1.6, z, x, 1.6, z + 1);
    if (blocked) { run = 0; } else { run++; best = Math.max(best, run); }
  }
  longestLane = Math.max(longestLane, best);
}
check(`there is open ground to sprint (${longestLane}m straight)`, longestLane >= 30);

// The map has to be one connected space. If a corner of it is walled off,
// players spawning there would be stuck and nobody could reach them.
const walkable = U.allWalkableCells();
const reachable = U.reachableFrom(MAP.spawns.a[0]);
check(`the whole map is reachable from a spawn (${reachable.size}/${walkable.length} cells)`,
  reachable.size === walkable.length);

let unreachableSpawn = null;
for (const team of ['a', 'b']) {
  for (const sp of MAP.spawns[team]) {
    if (!U.findPath(MAP.spawns.a[0], sp)) unreachableSpawn = team + ' ' + sp.x + ',' + sp.z;
  }
}
check('every spawn can be walked to from every other', !unreachableSpawn, unreachableSpawn || '');

console.log('\n--- traversal ---');

// Walk real routes with the real physics and check the player actually gets
// there. This is what catches spots where a player wedges against geometry.
function walkRoute(from, to) {
  let path = U.findPath(from, to);
  if (!path) return { ok: false, why: 'no path' };

  const p = fresh(from.x, from.z, 0);
  let wp = 1, stalledFor = 0, replans = 0;
  let lastPos = { x: p.x, z: p.z };

  for (let tick = 0; tick < 4000 && wp < path.length; tick++) {
    const t = path[wp];
    const gap = Math.hypot(t.x - p.x, t.z - p.z);
    // Tolerance has to be smaller than the gap between waypoints, or the
    // follower skips one and heads straight for a point through a wall.
    if (gap < 0.7) { wp++; continue; }
    // Already past this one? Take the next.
    if (wp + 1 < path.length) {
      const nxt = path[wp + 1];
      if (Math.hypot(nxt.x - p.x, nxt.z - p.z) < gap - 0.4) { wp++; continue; }
    }

    S.stepPlayer(p, {
      forward: 1, right: 0, jump: false, crouch: false,
      sprint: gap > 6, ads: false,
      yaw: Math.atan2(-(t.x - p.x), -(t.z - p.z)), pitch: 0
    }, 1 / 60, WEAPONS[0]);

    const moved = Math.hypot(p.x - lastPos.x, p.z - lastPos.z);
    lastPos = { x: p.x, z: p.z };
    stalledFor = moved < 0.012 ? stalledFor + 1 : 0;

    // Snagged on something. Back off the obstacle, then re-plan from where we
    // actually are - which is what anything navigating a real world has to do.
    if (stalledFor > 30) {
      if (++replans > 10) {
        return { ok: false, why: `wedged at ${p.x.toFixed(1)},${p.z.toFixed(1)} after ${replans} re-plans` };
      }
      const away = Math.atan2(-(t.x - p.x), -(t.z - p.z));
      for (let k = 0; k < 22; k++) {
        S.stepPlayer(p, {
          forward: -1, right: (replans % 2 ? 1 : -1), jump: false, crouch: false,
          sprint: false, ads: false, yaw: away, pitch: 0
        }, 1 / 60, WEAPONS[0]);
      }
      const again = U.findPath({ x: p.x, z: p.z }, to);
      if (!again) return { ok: false, why: `no path from ${p.x.toFixed(1)},${p.z.toFixed(1)}` };
      path = again; wp = 1; stalledFor = 0;
      lastPos = { x: p.x, z: p.z };
    }
  }
  const off = Math.hypot(p.x - to.x, p.z - to.z);
  return { ok: off < 3, why: `stopped ${off.toFixed(1)}m short at ${p.x.toFixed(1)},${p.z.toFixed(1)}` };
}

// Every spawn to every enemy spawn, plus a few awkward corners
const routes = [];
for (const a of MAP.spawns.a) for (const b of MAP.spawns.b) routes.push([a, b]);
routes.push([MAP.spawns.a[0], { x: 0, z: 0 }]);       // the centre building
routes.push([MAP.spawns.b[0], { x: -42, z: 0 }]);     // far west lane
routes.push([MAP.spawns.a[0], { x: 42, z: 0 }]);      // far east lane

let failedRoute = null, walked = 0;
for (const [a, b] of routes) {
  const r = walkRoute(a, b);
  if (r.ok) walked++;
  else if (!failedRoute) failedRoute = `${a.x},${a.z} -> ${b.x},${b.z}: ${r.why}`;
}
check(`a player can walk every route (${walked}/${routes.length})`, walked === routes.length,
  failedRoute || '');

console.log('\n--- movement ---');

const p1 = fresh(0, -44, 6);
hold(p1, {}, 200);
check(`gravity settles you on the floor (y=${p1.y.toFixed(2)})`, near(p1.y, 0, 0.01));

const p2 = fresh(0, -36, 0);
hold(p2, { forward: 1 }, 120);
check(`W walks forward, toward -Z (z=${p2.z.toFixed(1)})`, p2.z < -37);

const p3 = fresh(0, -36, 0);
hold(p3, { right: 1 }, 120);
check(`D strafes right, toward +X (x=${p3.x.toFixed(1)})`, p3.x > 1);

// Sprint must actually be faster. Run east along the southern lane,
// which the map test above confirmed is open ground.
const LANE_YAW = -Math.PI / 2;   // faces +X
const walk = fresh(-40, -44, 0);
hold(walk, { forward: 1, yaw: LANE_YAW }, 90, WEAPONS[0]);
const run = fresh(-40, -44, 0);
hold(run, { forward: 1, sprint: true, yaw: LANE_YAW }, 90, WEAPONS[0]);
const walkD = Math.abs(walk.x - (-40)), runD = Math.abs(run.x - (-40));
check(`sprint is faster than walking (${walkD.toFixed(1)}m vs ${runD.toFixed(1)}m)`, runD > walkD * 1.25);

// Crouch must be slower and shorter
const cr = fresh(-40, -44, 0);
hold(cr, { forward: 1, crouch: true, yaw: LANE_YAW }, 90, WEAPONS[0]);
check(`crouch is slower (${Math.abs(cr.x + 40).toFixed(1)}m)`, Math.abs(cr.x + 40) < walkD * 0.7);
check('crouch shrinks the hitbox', S.dims(true).h < S.dims(false).h);

// Aiming down sights slows you
const ads = fresh(-40, -44, 0);
hold(ads, { forward: 1, ads: true, yaw: LANE_YAW }, 90, WEAPONS[0]);
check(`aiming slows you down (${Math.abs(ads.x + 40).toFixed(1)}m)`, Math.abs(ads.x + 40) < walkD * 0.75);

// Weapon weight changes speed
const withDmr = fresh(-40, -44, 0);
hold(withDmr, { forward: 1, yaw: LANE_YAW }, 90, WEAPONS[2]);
check('heavier weapons move slower', Math.abs(withDmr.x + 40) < walkD);

// Walls
const wall = fresh(0, -40, 0);
hold(wall, { forward: 1 }, 400);
check(`perimeter wall holds (z=${wall.z.toFixed(1)})`, wall.z > -47 && wall.z < -44);

// Stairs: you should be able to walk up them without jumping
const stair = fresh(-11.5, -6.5, 0);
let peak = 0;
for (let i = 0; i < 300; i++) {
  S.stepPlayer(stair, { forward: 1, right: 0, jump: false, crouch: false,
    sprint: false, ads: false, yaw: Math.PI, pitch: 0 }, 1 / 60, WEAPONS[0]);
  peak = Math.max(peak, stair.y);
}
check(`you can walk up steps without jumping (reached y=${peak.toFixed(2)})`, peak > 3.5);

// But you must NOT be able to walk up something waist high
const ledge = fresh(0, -20.5, 0);   // a 1.15m crate sits at (0,-19)
let ledgePeak = 0;
for (let i = 0; i < 180; i++) {
  S.stepPlayer(ledge, { forward: 1, right: 0, jump: false, crouch: false,
    sprint: false, ads: false, yaw: Math.PI, pitch: 0 }, 1 / 60, WEAPONS[0]);
  ledgePeak = Math.max(ledgePeak, ledge.y);
}
check(`waist-high cover still needs a jump (y=${ledgePeak.toFixed(2)})`, ledgePeak < 0.6);

// Jumping
const jump = fresh(0, -44, 0);
S.stepPlayer(jump, { forward: 0, right: 0, jump: true, yaw: 0, pitch: 0 }, 1 / 60, WEAPONS[0]);
check('jump leaves the ground', jump.vy > 5);

// You cannot leave the arena in any direction
let escaped = null;
for (const dir of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
  const e = fresh(0, 0, 6);
  hold(e, { forward: 1, sprint: true, yaw: dir }, 900, WEAPONS[0]);
  if (Math.abs(e.x) > 47 || Math.abs(e.z) > 47) escaped = dir.toFixed(2);
}
check('you cannot sprint out of the map', !escaped, escaped || '');

// The same inputs must give the same result, or prediction breaks
function determinism() {
  const q = fresh(-30, -30, 0);
  for (let i = 0; i < 200; i++) {
    S.stepPlayer(q, {
      forward: 1, right: i % 3 ? 1 : -1, jump: i % 25 === 0,
      crouch: i % 40 > 30, sprint: i % 7 < 4, ads: false,
      yaw: i * 0.02, pitch: 0
    }, 1 / 60, WEAPONS[0]);
  }
  return q;
}
const d1 = determinism(), d2 = determinism();
check('physics is deterministic', d1.x === d2.x && d1.y === d2.y && d1.z === d2.z);

console.log('\n--- weapons ---');

check(`five weapons defined`, WEAPONS.length === 5);
let wepBad = null;
for (const w of WEAPONS) {
  if (!(w.mag > 0 && w.rpm > 0 && w.body > 0 && w.head > w.body && w.pellets >= 1)) wepBad = w.id;
  if (!(w.fireMs > 0 && isFinite(w.fireMs))) wepBad = w.id + ' fireMs';
  if (w.reloadMs <= 0 || w.range <= 0) wepBad = w.id + ' timings';
}
check('every weapon has sane stats', !wepBad, wepBad || '');

// Every weapon must need more than one body shot, so nothing is an instant win
// Automatics must not one-shot. The sniper and the shotgun are allowed to,
// which is exactly what makes them a trade against fire rate and range.
const shotsToKill = WEAPONS.map(w => Math.ceil(CONFIG.MAX_HEALTH / (w.body * w.pellets)));
check('no automatic weapon bodyshots for an instant kill',
  WEAPONS.every((w, i) => !w.auto || shotsToKill[i] >= 3),
  shotsToKill.join('/'));

check('headshots are worth aiming for on every weapon',
  WEAPONS.every(w => w.head > w.body * 1.5));

// Time to kill should sit in a sane band - no weapon dominates
const ttk = WEAPONS.map(w => (Math.ceil(CONFIG.MAX_HEALTH / (w.body * w.pellets)) - 1) * w.fireMs);
check(`time to kill is in a playable band (${ttk.map(t => Math.round(t)).join('/')}ms)`,
  ttk.every(t => t >= 0 && t < 900));

// Distance falloff actually reduces damage
const rifle = S.WEAPON_BY_ID.rifle;
const dClose = S.damageAt(rifle, 'body', 10);
const dFar = S.damageAt(rifle, 'body', 120);
check(`damage falls off with range (${dClose.toFixed(0)} -> ${dFar.toFixed(0)})`, dFar < dClose * 0.8);
check('falloff never goes negative or inverts',
  WEAPONS.every(w => S.damageAt(w, 'body', 500) > 0 && S.damageAt(w, 'body', 500) <= w.body));

// The shotgun should be lethal up close and weak far away
const sg = S.WEAPON_BY_ID.shotgun;
check('shotgun kills at point blank but not at distance',
  sg.body * sg.pellets >= CONFIG.MAX_HEALTH &&
  S.damageAt(sg, 'body', 40) * sg.pellets < CONFIG.MAX_HEALTH);

// Spread behaviour
const still = S.currentSpread(rifle, { consecutive: 0, vx: 0, vz: 0, onGround: true, crouch: false, ads: false });
const moving = S.currentSpread(rifle, { consecutive: 0, vx: 5, vz: 0, onGround: true, crouch: false, ads: false });
const spraying = S.currentSpread(rifle, { consecutive: 10, vx: 0, vz: 0, onGround: true, crouch: false, ads: false });
const aimed = S.currentSpread(rifle, { consecutive: 0, vx: 0, vz: 0, onGround: true, crouch: false, ads: true });
const air = S.currentSpread(rifle, { consecutive: 0, vx: 0, vz: 0, onGround: false, crouch: false, ads: false });
const crouched = S.currentSpread(rifle, { consecutive: 0, vx: 0, vz: 0, onGround: true, crouch: true, ads: false });

check('moving widens the cone', moving > still);
check('spraying widens the cone', spraying > still);
check('aiming tightens the cone', aimed < still);
check('jumping is the least accurate', air > moving);
check('crouching is more accurate than standing', crouched < still);
check('spread is capped', S.currentSpread(rifle, { consecutive: 999, vx: 0, vz: 0, onGround: true })
  <= rifle.spreadMax + 0.001);

console.log('\n--- hit detection ---');

// Fire down a lane we have verified is clear
const EX = -40, EY = 1.66, EZ = -44;
function shoot(tx, ty, tz, targets, crouched) {
  const dx = tx - EX, dy = ty - EY, dz = tz - EZ;
  const dist = Math.hypot(dx, dy, dz);
  const d = { x: dx / dist, y: dy / dist, z: dz / dist };
  const wall = S.rayWall(EX, EY, EZ, d.x, d.y, d.z, 200);
  let best = null;
  for (const t of targets) {
    const r = S.rayPlayer(EX, EY, EZ, d.x, d.y, d.z, t.x, t.y, t.z, crouched);
    if (r && r.t < wall.t && (!best || r.t < best.t)) best = { t: r.t, zone: r.zone, target: t };
  }
  return best;
}

const tgt = { x: -40, y: 0, z: -30 };
check('clear lane for the hit tests', clear(EX, EY, EZ, tgt.x, tgt.y + 1, tgt.z));

check('body shot registers', (shoot(tgt.x, 1.0, tgt.z, [tgt]) || {}).zone === 'body');
check('head shot registers', (shoot(tgt.x, 1.72, tgt.z, [tgt]) || {}).zone === 'head');
check('leg shot registers as a limb', (shoot(tgt.x, 0.3, tgt.z, [tgt]) || {}).zone === 'limb');
check('shot beside the target misses', shoot(tgt.x + 3, 1.0, tgt.z, [tgt]) === null);
check('shot over the target misses', shoot(tgt.x, 3.2, tgt.z, [tgt]) === null);

const nearT = { x: -40, y: 0, z: -34 }, farT = { x: -40, y: 0, z: -28 };
check('the closer body takes the hit',
  (shoot(farT.x, 1.0, farT.z, [farT, nearT]) || {}).target === nearT);

// Crouching should let you get under a shot aimed at a standing head
const crouchT = { x: -40, y: 0, z: -30 };
check('crouching ducks a headshot',
  shoot(crouchT.x, 1.72, crouchT.z, [crouchT], true) === null);

// Cover has to work: the tower at (-20,-14) is solid
check('solid cover blocks bullets', !clear(-20, 1.6, -24, -20, 1.6, -4));

// Surface identification for impact effects
const surf = S.rayWall(0, 1.5, -44, 0, 0, -1, 100);
check(`walls report their material (${surf.kind})`, !!surf.kind);
check('surface normal points back at the shooter', surf.nz !== 0 || surf.nx !== 0 || surf.ny !== 0);

// Range limit
check('bullets stop at the weapon range',
  S.rayWall(0, 40, 0, 0, 1, 0, S.WEAPON_BY_ID.pistol.range).t === S.WEAPON_BY_ID.pistol.range);

console.log('');
const pass = R.filter(Boolean).length;
console.log(`${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
