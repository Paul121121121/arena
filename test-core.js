// Core tests - the pure logic in shared.js. No server, no browser.
const S = require('./public/shared.js');
const U = require('./test-util.js');
const { CONFIG, WEAPONS, MAP } = S;

const R = [];
const check = (n, ok, note) => { R.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : '')); };
const near = (a, b, t) => Math.abs(a - b) <= t;

function fresh(x, z, y) {
  return { x, y: y === undefined ? 0 : y, z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, crouch: false, jumps: 0 };
}
function hold(p, input, ticks, w, flag) {
  const base = { forward: 0, right: 0, jumpEdge: false, crouch: false, sprint: false, yaw: 0, pitch: 0 };
  for (let i = 0; i < ticks; i++) S.stepPlayer(p, Object.assign({}, base, input), 1 / 60, w, flag);
  return p;
}

console.log('--- map ---');
check('the map is a decent size', MAP.width >= 100 && MAP.depth >= 90);
check(`geometry is present (${MAP.boxes.length} boxes)`, MAP.boxes.length > 80);
check('both teams have a flag stand', MAP.flags.a && MAP.flags.b);
check('the flags are far apart', Math.hypot(MAP.flags.a.x - MAP.flags.b.x, MAP.flags.a.z - MAP.flags.b.z) > 70);
check('both teams have spawns', MAP.spawns.a.length >= 3 && MAP.spawns.b.length >= 3);
check(`weapon pedestals exist (${MAP.pedestals.length})`, MAP.pedestals.length >= 6);
check('there are ranged pedestals', MAP.pedestals.some(p => p.id === 'bow') && MAP.pedestals.some(p => p.id === 'crossbow'));
check('there are medkit spots', MAP.medkitSpots.length >= 6);

let badBox = null;
for (const b of MAP.boxes) if (b.w <= 0 || b.h <= 0 || b.d <= 0 || b.y < -0.001) { badBox = b; break; }
check('every box has valid dimensions', !badBox, badBox ? JSON.stringify(badBox) : '');

let stuck = null;
for (const team of ['a', 'b']) for (const sp of MAP.spawns[team]) {
  const p = fresh(sp.x, sp.z, 0.2); hold(p, {}, 90);
  if (Math.hypot(p.x - sp.x, p.z - sp.z) > 1.3) stuck = `${team} ${sp.x},${sp.z}`;
}
check('no spawn is inside a wall', !stuck, stuck || '');

for (const key of ['a', 'b']) {
  const f = MAP.flags[key]; const p = fresh(f.x, f.z, 0.2); hold(p, {}, 90);
  check(`${key} flag stand is standable`, Math.hypot(p.x - f.x, p.z - f.z) < 1.3);
}

console.log('\n--- connectivity ---');
const walkable = U.allWalkableCells();
const reach = U.reachableFrom(MAP.spawns.a[0]);
check(`most of the map is reachable (${Math.round(100*reach.size/walkable.length)}%)`, reach.size / walkable.length > 0.8);
const routeToEnemyFlag = U.findPath(MAP.spawns.a[0], MAP.flags.b);
check(`there is a route from spawn to the enemy flag (${routeToEnemyFlag ? routeToEnemyFlag.length : 0} waypoints)`, !!routeToEnemyFlag);
check('there is a route from the enemy flag back home', !!U.findPath(MAP.flags.b, MAP.flags.a));

console.log('\n--- movement ---');
// Find genuinely open ground (groundHeight 0) near the map centre for the fall test
let openX = 0, openZ = 0;
for (let z = 0; z <= 20 && S.groundHeight(openX, openZ, 6) > 0.01; z += 2) openZ = z;
const grav = fresh(openX, openZ, 6); hold(grav, {}, 200);
check(`gravity settles you on the floor (y=${grav.y.toFixed(2)})`, near(grav.y, S.groundHeight(openX, openZ, 0), 0.05));
const fwd = fresh(0, 0, 0); hold(fwd, { forward: 1 }, 60, WEAPONS[0]);
check(`W walks toward -Z (z=${fwd.z.toFixed(1)})`, fwd.z < -1);
const strafe = fresh(0, 0, 0); hold(strafe, { right: 1 }, 60, WEAPONS[0]);
check(`D strafes toward +X (x=${strafe.x.toFixed(1)})`, strafe.x > 1);

function topSpeed(input, w, flag) { const p = fresh(0, 0, 0); hold(p, Object.assign({ forward: 1 }, input), 120, w, flag); return Math.hypot(p.vx, p.vz); }
const walkSpd = topSpeed({}, WEAPONS[0]);
const sprintSpd = topSpeed({ sprint: true }, WEAPONS[0]);
const crouchSpd = topSpeed({ crouch: true }, WEAPONS[0]);
check(`sprint is faster than walk (${walkSpd.toFixed(1)} -> ${sprintSpd.toFixed(1)})`, sprintSpd > walkSpd * 1.25);
check(`crouch is slower (${crouchSpd.toFixed(1)})`, crouchSpd < walkSpd * 0.7);
check('crouch shrinks the hitbox', S.dims(true).h < S.dims(false).h);
check('carrying the flag slows you', topSpeed({}, WEAPONS[0], true) < walkSpd);

console.log('\n--- double jump ---');
const j = fresh(0, MAP.spawns.a[0].z, 0);
S.stepPlayer(j, { forward: 0, right: 0, jumpEdge: true, yaw: 0, pitch: 0 }, 1/60, WEAPONS[0], false);
check('first jump leaves the ground', j.vy > 5);
check('first jump counts', j.jumps === 1);
for (let i = 0; i < 12; i++) S.stepPlayer(j, { forward: 0, right: 0, jumpEdge: false, yaw: 0, pitch: 0 }, 1/60, WEAPONS[0], false);
S.stepPlayer(j, { forward: 0, right: 0, jumpEdge: true, yaw: 0, pitch: 0 }, 1/60, WEAPONS[0], false);
check(`second jump works in the air (vy=${j.vy.toFixed(1)})`, j.vy > 4 && j.jumps === 2);
S.stepPlayer(j, { forward: 0, right: 0, jumpEdge: true, yaw: 0, pitch: 0 }, 1/60, WEAPONS[0], false);
check('no triple jump', j.jumps === 2);
const jh = fresh(0, MAP.spawns.a[0].z, 0);
S.stepPlayer(jh, { forward: 0, right: 0, jumpEdge: true, yaw: 0, pitch: 0 }, 1/60, WEAPONS[0], false);
S.stepPlayer(jh, { forward: 0, right: 0, jumpEdge: false, yaw: 0, pitch: 0 }, 1/60, WEAPONS[0], false);
check('holding jump keeps the second in reserve', jh.jumps === 1);

function runDet() { const q = fresh(0, 0, 0); for (let i = 0; i < 200; i++)
  S.stepPlayer(q, { forward: 1, right: i%3?1:-1, jumpEdge: i%40===0, crouch: i%50>40, sprint: i%7<4, yaw: i*0.02, pitch: 0 }, 1/60, WEAPONS[0], false); return q; }
const r1 = runDet(), r2 = runDet();
check('physics is deterministic', r1.x === r2.x && r1.y === r2.y && r1.z === r2.z);

console.log('\n--- weapons ---');
check('everyone starts with fists', WEAPONS[S.FISTS].id === 'fists');
check('six weapons exist', WEAPONS.length === 6);
check('there is a melee and ranged mix', WEAPONS.some(w => w.kind === 'melee') && WEAPONS.filter(w => w.kind === 'ranged').length >= 2);
let wbad = null;
for (const w of WEAPONS) {
  if (!(w.damage > 0 && w.cooldownMs > 0 && w.headMul >= 1)) wbad = w.id;
  if (w.kind === 'melee' && !(w.reach > 0 && w.arc > 0 && w.windupMs >= 0)) wbad = w.id + ' melee';
  if (w.kind === 'ranged' && !(w.speed > 0 && w.drop >= 0)) wbad = w.id + ' ranged';
}
check('every weapon has sane stats', !wbad, wbad || '');
check('fists are the weakest', WEAPONS[S.FISTS].damage === Math.min.apply(null, WEAPONS.map(w => w.damage)));
check('no weapon bodyshots for a one-hit kill', WEAPONS.every(w => w.damage < CONFIG.MAX_HEALTH));
check('the spear outranges other melee', S.WEAPON_BY_ID.spear.reach > S.WEAPON_BY_ID.sword.reach);
check('the crossbow hits harder but slower than the bow',
  S.WEAPON_BY_ID.crossbow.damage > S.WEAPON_BY_ID.bow.damage && S.WEAPON_BY_ID.crossbow.cooldownMs > S.WEAPON_BY_ID.bow.cooldownMs);
check('the bolt flies flatter than the arrow', S.WEAPON_BY_ID.crossbow.drop < S.WEAPON_BY_ID.bow.drop);

console.log('\n--- melee cone ---');
const att = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouch: false };
const sword = S.WEAPON_BY_ID.sword;
const target = (x, z) => ({ x, y: 0, z, crouch: false });
check('melee hits an enemy directly ahead', S.meleeHits(att, sword, [target(0, -2)]).length === 1);
check('melee misses an enemy behind', S.meleeHits(att, sword, [target(0, 2)]).length === 0);
check('melee misses an enemy out of reach', S.meleeHits(att, sword, [target(0, -6)]).length === 0);
check('melee misses an enemy off to the side', S.meleeHits(att, sword, [target(4, 0)]).length === 0);
check('the spear reaches further than the sword',
  S.meleeHits(att, S.WEAPON_BY_ID.spear, [target(0, -3.8)]).length === 1 && S.meleeHits(att, sword, [target(0, -3.8)]).length === 0);

console.log('\n--- projectiles ---');
const bow = S.WEAPON_BY_ID.bow;
let pr = { x: 0, y: 1.6, z: 0, px: 0, py: 1.6, pz: 0, vx: 0, vy: 0, vz: -bow.speed, drop: bow.drop, life: 5 };
for (let i = 0; i < 30; i++) S.stepProjectile(pr, 1/60);
check(`arrows drop under gravity (fell ${(1.6 - pr.y).toFixed(2)}m)`, pr.y < 1.6);
check('arrows travel downrange', pr.z < -10);
const cb = S.WEAPON_BY_ID.crossbow;
let ar = { x:0,y:1.6,z:0,px:0,py:1.6,pz:0,vx:0,vy:0,vz:-bow.speed,drop:bow.drop,life:5 };
let bo = { x:0,y:1.6,z:0,px:0,py:1.6,pz:0,vx:0,vy:0,vz:-cb.speed,drop:cb.drop,life:5 };
for (let i = 0; i < 30; i++) { S.stepProjectile(ar, 1/60); S.stepProjectile(bo, 1/60); }
check('the bolt drops less than the arrow', (1.6 - bo.y) < (1.6 - ar.y));
// March an arrow down open ground toward a player and confirm it connects.
let hitP = { x: openX, y: 1.4, z: openZ, px: openX, py: 1.4, pz: openZ, vx: 0, vy: 0, vz: -bow.speed, drop: 0, life: 5 };
const enemy = { x: openX, y: S.groundHeight(openX, openZ - 8, 0), z: openZ - 8, crouch: false };
let connected = null;
for (let i = 0; i < 60 && !connected; i++) {
  S.stepProjectile(hitP, 1/60);
  const r = S.projectileHit(hitP, [enemy]);
  if (r) connected = r;
}
check('a projectile hits a player in its path', connected && connected.kind === 'player', connected ? connected.kind : 'no hit');

console.log('\n--- teams ---');
const shuffle = S.balancedShuffle([1,2,3,4,5,6]);
check('shuffle assigns everyone a team', Object.keys(shuffle).length === 6);
const na = Object.values(shuffle).filter(t => t === 'a').length;
check(`shuffle balances the teams (${na} vs ${6-na})`, Math.abs(na - 3) === 0);

console.log('');
const pass = R.filter(Boolean).length;
console.log(`${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
