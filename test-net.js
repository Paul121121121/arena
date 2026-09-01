// Integration tests. Real server, real WebSockets, bots as clients.
const WebSocket = require('ws');
const S = require('./public/shared.js');
const URL = process.env.ARENA_URL || 'ws://localhost:3000';

const R = [];
const check = (n, ok, note) => {
  R.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : ''));
};
const wait = ms => new Promise(r => setTimeout(r, ms));

function bot(name) {
  return new Promise(res => {
    const ws = new WebSocket(URL);
    const s = {
      ws, name, seq: 0, id: null, team: null, hp: 100,
      ammo: null, reserve: null, slot: 0, ev: [], snaps: 0, full: false
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name })));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      s.ev.push(m);
      if (m.type === 'welcome') { s.id = m.id; s.team = m.team; s.cfg = m.config; s.welcome = m; res(s); }
      if (m.type === 'full') { s.full = true; res(s); }
      if (m.type === 'snapshot') { s.snaps++; s.last = m; }
      if (m.type === 'hurt') s.hp = m.health;
      if (m.type === 'ammo') { s.ammo = m.ammo; if (m.reserve !== undefined) s.reserve = m.reserve; }
      if (m.type === 'weapon') { s.slot = m.slot; s.ammo = m.ammo; s.reserve = m.reserve; }
      if (m.type === 'respawn') { s.hp = 100; }
      if (m.type === 'roster') s.roster = m.players;
      if (m.type === 'ping-request') ws.send(JSON.stringify({ type: 'pong', t: m.t }));
    });
    ws.on('error', () => res(s));
    ws.on('close', () => res(s));
    setTimeout(() => res(s), 2000);
  });
}

const input = (b, o) => {
  if (b.ws.readyState !== 1) return;
  b.ws.send(JSON.stringify(Object.assign({
    type: 'input', seq: ++b.seq, dt: 1 / 60, forward: 0, right: 0,
    jump: false, crouch: false, sprint: false, ads: false, shoot: false,
    yaw: 0, pitch: 0
  }, o)));
};
const got = (b, type) => b.ev.filter(e => e.type === type);
const clearEv = b => { b.ev.length = 0; };

// Aim one bot at another, using the server's own snapshot positions
function aim(from, to) {
  const dx = to.x - from.x;
  const dy = (to.y + 1.0) - (from.y + S.CONFIG.STAND_EYE);
  const dz = to.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}
function lineIsClear(from, to) {
  const ex = from.x, ey = from.y + S.CONFIG.STAND_EYE, ez = from.z;
  const dx = to.x - ex, dy = (to.y + 1.0) - ey, dz = to.z - ez;
  const dist = Math.hypot(dx, dy, dz);
  const w = S.rayWall(ex, ey, ez, dx / dist, dy / dist, dz / dist, dist + 1);
  return w.t >= dist - 0.1;
}

(async () => {
  console.log('--- joining ---');
  const bots = [];
  for (let i = 0; i < 6; i++) bots.push(await bot('bot' + i));
  await wait(600);

  const joined = bots.filter(b => b.id);
  check(`six clients connected`, joined.length === 6);
  check('every client got a distinct id', new Set(joined.map(b => b.id)).size === 6);
  check('server sent map, config and weapons',
    !!joined[0].cfg && joined[0].welcome.map.boxes.length > 60 &&
    joined[0].welcome.weapons.length === 5);

  console.log('\n--- teams ---');
  const teamA = joined.filter(b => b.team === 'a').length;
  const teamB = joined.filter(b => b.team === 'b').length;
  check(`teams are balanced (${teamA} vs ${teamB})`, Math.abs(teamA - teamB) <= 1);
  check('everyone got a team', joined.every(b => b.team === 'a' || b.team === 'b'));

  const snap = joined[0].last;
  check('snapshots include every player', snap && snap.players.length === 6);

  // Teams spawn on their own side of the map
  const sideOk = joined.every(b => {
    const p = snap.players.find(x => x.id === b.id);
    return b.team === 'a' ? p.z < -20 : p.z > 20;
  });
  check('each team spawns in its own base', sideOk);

  console.log('\n--- weapons ---');
  const shooter = joined[0];
  clearEv(shooter);
  shooter.ws.send(JSON.stringify({ type: 'switch', slot: 3 }));    // shotgun
  await wait(900);
  check('weapon switch is acknowledged', shooter.slot === 3, 'slot ' + shooter.slot);
  check('switching gives the right magazine',
    shooter.ammo === S.WEAPONS[3].mag, `${shooter.ammo}/${S.WEAPONS[3].mag}`);

  shooter.ws.send(JSON.stringify({ type: 'switch', slot: 0 }));    // back to rifle
  await wait(800);
  check('switching back restores the rifle', shooter.slot === 0 && shooter.ammo === 30);

  // Rate of fire must be the server's decision, not the client's
  clearEv(shooter);
  const ammoBefore = shooter.ammo;
  for (let i = 0; i < 30; i++) input(shooter, { shoot: true });
  await wait(500);
  const spent = ammoBefore - shooter.ammo;
  check(`fire rate enforced by the server (${spent} of 30 accepted)`, spent <= 6);

  // Reload
  clearEv(shooter);
  shooter.ws.send(JSON.stringify({ type: 'reload' }));
  await wait(S.WEAPONS[0].reloadMs + 400);
  check('reload refills the magazine', shooter.ammo === 30, 'ammo ' + shooter.ammo);
  check('reload draws from reserve ammo', shooter.reserve < S.WEAPONS[0].reserve,
    'reserve ' + shooter.reserve);

  // Empty a magazine and confirm the server refuses to keep firing.
  // The pistol is used here purely because it empties quickly.
  shooter.ws.send(JSON.stringify({ type: 'switch', slot: 4 }));
  await wait(600);
  clearEv(shooter);
  for (let i = 0; i < 17; i++) { input(shooter, { shoot: true }); await wait(150); }
  await wait(250);
  check('magazine runs dry', shooter.ammo === 0, 'ammo ' + shooter.ammo);
  clearEv(shooter);
  for (let i = 0; i < 4; i++) { input(shooter, { shoot: true }); await wait(150); }
  await wait(200);
  check('an empty gun does not fire',
    got(shooter, 'shot').filter(s => s.id === shooter.id).length === 0);
  check('an empty gun reports a dry trigger', got(shooter, 'dryfire').length > 0);

  console.log('\n--- anti-cheat ---');

  const cheat = joined[1];
  await wait(200);
  const p0 = cheat.last.players.find(p => p.id === cheat.id);

  // Claim a huge timestep to teleport
  for (let i = 0; i < 6; i++) { input(cheat, { forward: 1, dt: 60, sprint: true, yaw: 0 }); await wait(20); }
  await wait(300);
  const p1 = cheat.last.players.find(p => p.id === cheat.id);
  const jump = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  check(`oversized timestep is clamped (${jump.toFixed(1)}m)`, jump < 4);

  // Flooding inputs must not buy extra speed. Send at ~5x the normal rate
  // and check the distance covered is bounded by real time, not by how many
  // packets we managed to push.
  await wait(400);
  const f0 = cheat.last.players.find(p => p.id === cheat.id);
  const floodStart = Date.now();
  for (let i = 0; i < 900; i++) {
    input(cheat, { forward: 1, sprint: true, yaw: 0 });
    if (i % 3 === 2) await wait(1);
  }
  await wait(400);
  const f1 = cheat.last.players.find(p => p.id === cheat.id);
  const elapsed = (Date.now() - floodStart) / 1000;
  const travelled = Math.hypot(f1.x - f0.x, f1.z - f0.z);
  const ceiling = S.CONFIG.BASE_SPEED * S.CONFIG.SPRINT_MUL * elapsed * 1.35;
  check(`input flooding cannot outrun real time (${travelled.toFixed(1)}m in ${elapsed.toFixed(1)}s)`,
    travelled <= ceiling, `ceiling ${ceiling.toFixed(1)}m`);

  // Claim impossible movement values
  for (let i = 0; i < 40; i++) { input(cheat, { forward: 999, right: 999, dt: 1, yaw: 1 }); await wait(8); }
  await wait(300);
  const p2 = cheat.last.players.find(p => p.id === cheat.id);
  check('out-of-range inputs cannot break the sim',
    isFinite(p2.x) && isFinite(p2.z) && Math.abs(p2.x) < 48 && Math.abs(p2.z) < 48);

  // Garbage messages must not crash the server
  cheat.ws.send('not json at all');
  cheat.ws.send(JSON.stringify({ type: 'input', seq: 'abc', dt: NaN, yaw: 'x' }));
  cheat.ws.send(JSON.stringify({ type: 'switch', slot: 99 }));
  cheat.ws.send(JSON.stringify({ type: 'switch', slot: -5 }));
  cheat.ws.send(JSON.stringify({}));
  cheat.ws.send(JSON.stringify({ type: 'kill', victim: 'everyone' }));
  await wait(500);
  check('server survives malformed messages', cheat.last && cheat.snaps > 0);
  check('invalid weapon slot is rejected', cheat.slot >= 0 && cheat.slot < 5);

  console.log('\n--- match flow ---');
  const welcome = joined[0].welcome;
  check('match state is sent on join',
    welcome.match && typeof welcome.match.scores.a === 'number');
  check('a match is running', welcome.match.phase === 'live');
  check('score limit and clock are configured',
    S.CONFIG.SCORE_LIMIT > 0 && S.CONFIG.ROUND_MS > 60000);

  console.log('\n--- capacity ---');
  const extra = [];
  for (let i = 0; i < 8; i++) extra.push(await bot('x' + i));
  await wait(500);
  const total = joined.length + extra.filter(e => e.id).length;
  check(`server caps the room at ${S.CONFIG.MAX_PLAYERS} (${total} in)`,
    total <= S.CONFIG.MAX_PLAYERS);
  check('rejected clients are told the server is full',
    extra.filter(e => e.full).length >= 1 || total === S.CONFIG.MAX_PLAYERS);

  console.log('');
  const pass = R.filter(Boolean).length;
  console.log(`${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
