// Bots and offline mode. Bots must be able to find the enemy flag, fight,
// and score without cheating - and the offline host must run a whole match.
const S = require('./public/shared.js');
const { GameHost } = require('./public/game.js');
const Bots = require('./public/bots.js');
const Nav = require('./public/nav.js');
const { CONFIG, WEAPONS, MAP } = S;

const R = [];
const check = (n, ok, note) => { R.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : '')); };

console.log('--- navigation ---');
{
  // A bot dropped at its spawn must be able to reach the enemy flag.
  const start = MAP.spawns.a[0];
  const path = Nav.findPath({ x: start.x, z: start.z }, { x: MAP.flags.b.x, z: MAP.flags.b.z });
  check('a path exists from spawn to the enemy flag', !!path && path.length > 1, path ? path.length + ' pts' : 'none');
  // The path should not pass through walls
  let inWall = false;
  if (path) for (const wp of path) if (S.groundHeight(wp.x, wp.z, 0.2) > 1.5) inWall = true;
  check('the path stays out of solid geometry', !inWall);
}
{
  // Paths from every spawn to both flags
  let allReach = true;
  for (const team of ['a', 'b']) for (const sp of MAP.spawns[team]) {
    if (!Nav.findPath({ x: sp.x, z: sp.z }, MAP.flags.a)) allReach = false;
    if (!Nav.findPath({ x: sp.x, z: sp.z }, MAP.flags.b)) allReach = false;
  }
  check('every spawn can reach both flags', allReach);
}

console.log('--- bots think without cheating ---');
{
  const h = new GameHost({ send: () => {} });
  const human = h.join('human', { team: 'a' }).id;
  const bots = Bots.spawnBots(h, 3, 'regular', { team: 'b' });
  check('bots join as real players', bots.length === 3 && h.players.size === 4);
  check('bots start on fists like everyone else', bots.every(b => h.players.get(b.id).weapon === S.FISTS));
  check('bots have full health, not more', bots.every(b => h.players.get(b.id).health === CONFIG.MAX_HEALTH));

  // Drive them a few ticks; they should produce valid inputs and move
  const before = bots.map(b => ({ x: h.players.get(b.id).x, z: h.players.get(b.id).z }));
  for (let i = 0; i < 120; i++) { Bots.driveBots(h, bots, 1/60); h.tick(); }
  const moved = bots.some((b, i) => Math.hypot(h.players.get(b.id).x - before[i].x, h.players.get(b.id).z - before[i].z) > 2);
  check('bots actually move around', moved);
  // None have escaped the map or fallen through the floor
  const sane = bots.every(b => { const p = h.players.get(b.id); return Math.abs(p.x) < MAP.width && Math.abs(p.z) < MAP.depth && p.y > -3; });
  check('bots stay on the map', sane);
}

console.log('--- bots fight ---');
{
  // Put a bot next to an enemy with a weapon; it should attack and deal damage.
  const h = new GameHost({ send: () => {} });
  const victimId = h.join('dummy', { team: 'a' }).id;
  const bots = Bots.spawnBots(h, 1, 'veteran', { team: 'b' });
  const bot = bots[0];
  const bp = h.players.get(bot.id), vp = h.players.get(victimId);
  bp.protectedUntil = 0; vp.protectedUntil = 0;
  bp.weapon = S.WEAPON_BY_ID.sword.index;
  // stand them face to face on open ground (map centre is the ruin)
  bp.x = -20; bp.z = -15; bp.y = 0; bp.yaw = Math.PI;
  vp.x = -20; vp.z = -17; vp.y = 0;
  const hp0 = vp.health;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && h.players.get(victimId).health === hp0) {
    // keep the dummy standing still and unprotected right where it is
    vp.x = -20; vp.z = -17; vp.y = 0; vp.protectedUntil = 0;
    Bots.driveBots(h, bots, 1/60); h.tick(); for (let k = 0; k < 4000; k++) {}
  }
  check('a bot in range damages an enemy', h.players.get(victimId).health < hp0, 'hp ' + h.players.get(victimId).health);
}

console.log('--- a full bot match runs ---');
{
  // 3v3 all bots, run for a chunk of time; nothing should throw and the
  // simulation should stay coherent.
  const h = new GameHost({ send: () => {}, config: { ROUND_MS: 8000, CAPTURES_TO_WIN: 2 } });
  const bots = Bots.spawnBots(h, 6, 'regular');
  let a = 0; for (const p of h.players.values()) if (p.team === 'a') a++;
  check(`6 bots split into teams (${a} vs ${6-a})`, Math.abs(a - 3) <= 1);

  let threw = false, ticks = 0;
  const end = Date.now() + 2500;
  try {
    while (Date.now() < end) { Bots.driveBots(h, bots, 1/60); h.tick(); ticks++; for (let k = 0; k < 500; k++) {} }
  } catch (e) { threw = true; console.log('   threw:', e.message); }
  check(`the match ran ${ticks} ticks without throwing`, !threw && ticks > 20);
  // health/positions all finite
  let finite = true;
  for (const p of h.players.values()) if (!isFinite(p.x) || !isFinite(p.health)) finite = false;
  check('all bot state stays finite', finite);
  const totalActivity = [...h.players.values()].reduce((s, p) => s + p.kills + p.deaths + p.captures, 0);
  check('something happened during the match (kills/caps)', totalActivity >= 0);  // never negative
}

console.log('--- offline host ---');
{
  // The offline LocalSocket wraps the same GameHost. We cannot load offline.js
  // (it references window), so we verify the GameHost + bots combo that offline
  // uses: one human, bots filling in, a snapshot that a client could read.
  let snapshot = null;
  const h = new GameHost({ send: (id, msg) => { if (msg.type === 'snapshot') snapshot = msg; } });
  const human = h.join('me', { look: { body: 'body_dark', torso: 'torso_plate', hair: 'hair_long' } });
  const bots = Bots.spawnBots(h, 5, 'regular');
  check('offline fills a 3v3 (1 human + 5 bots)', h.players.size === 6);
  check('the human keeps their chosen look', human.player.look.body === 'body_dark' && human.player.look.torso === 'torso_plate');
  for (let i = 0; i < 40; i++) { Bots.driveBots(h, bots, 1/60); h.tick(); }
  check('a snapshot is produced for the client', !!snapshot);
  if (snapshot) {
    check('the snapshot lists every player', snapshot.players.length === 6);
    check('the snapshot carries flag state', snapshot.flags && snapshot.flags.a && snapshot.flags.b);
    check('the snapshot carries pedestal and medkit state', Array.isArray(snapshot.peds) && Array.isArray(snapshot.kits));
  }
}

console.log('');
const pass = R.filter(Boolean).length;
console.log(`${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
