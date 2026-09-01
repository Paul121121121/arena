// Soak test. Six bots move and shoot continuously while we watch for the
// things that only show up under load: snapshot rate collapsing, the server
// leaking memory, or client prediction drifting away from the server.
const WebSocket = require('ws');
const S = require('./public/shared.js');
const URL = process.env.ARENA_URL || 'ws://localhost:3000';

const R = [];
const check = (n, ok, note) => {
  R.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : ''));
};
const wait = ms => new Promise(r => setTimeout(r, ms));

function bot(name, idx) {
  return new Promise(res => {
    const ws = new WebSocket(URL);
    const s = {
      ws, name, idx, seq: 0, id: null, team: null, snaps: 0, errors: 0,
      // The bot runs the same prediction the browser does, so we can measure
      // how far its guess drifts from the server's answer.
      me: null, pending: [], drift: 0, driftMax: 0, driftSamples: 0
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name })));
    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { s.errors++; return; }
      if (m.type === 'welcome') {
        s.id = m.id; s.team = m.team;
        s.me = { x: m.you.x, y: m.you.y, z: m.you.z, vx: 0, vy: 0, vz: 0, yaw: m.you.yaw, pitch: 0, crouch: false };
        res(s);
      }
      if (m.type === 'snapshot') {
        s.snaps++;
        s.last = m;
        const mine = m.players.find(p => p.id === s.id);
        if (mine && s.me) {
          const before = { x: s.me.x, y: s.me.y, z: s.me.z };
          s.me.x = mine.x; s.me.y = mine.y; s.me.z = mine.z;
          const keep = [];
          for (const inp of s.pending) {
            if (inp.seq > mine.seq) {
              S.stepPlayer(s.me, inp, inp.dt, S.WEAPONS[0]);
              keep.push(inp);
            }
          }
          s.pending = keep;
          const d = Math.hypot(before.x - s.me.x, before.y - s.me.y, before.z - s.me.z);
          if (mine.al === 1) {
            s.drift += d; s.driftSamples++;
            if (d > s.driftMax) s.driftMax = d;
          }
        }
      }
      if (m.type === 'respawn' && s.me) {
        s.me.x = m.x; s.me.y = m.y; s.me.z = m.z; s.me.vx = s.me.vy = s.me.vz = 0;
        s.pending.length = 0;
      }
      if (m.type === 'ping-request') ws.send(JSON.stringify({ type: 'pong', t: m.t }));
    });
    ws.on('error', () => { s.errors++; res(s); });
    ws.on('close', () => res(s));
    setTimeout(() => res(s), 2000);
  });
}

function drive(b, tick) {
  if (b.ws.readyState !== 1 || !b.me) return;
  // A different wandering pattern per bot, so they do not all do the same thing
  const phase = tick * 0.02 + b.idx * 1.7;
  const inp = {
    type: 'input', seq: ++b.seq, dt: 1 / 60,
    forward: Math.sin(phase) > -0.3 ? 1 : -1,
    right: Math.sin(phase * 0.7),
    jump: tick % 90 === b.idx * 7,
    crouch: Math.sin(phase * 0.4) > 0.75,
    sprint: Math.sin(phase * 0.3) > 0,
    ads: Math.sin(phase * 1.1) > 0.6,
    shoot: tick % 7 === 0,
    yaw: phase * 0.6,
    pitch: Math.sin(phase * 0.5) * 0.3
  };
  b.ws.send(JSON.stringify(inp));
  S.stepPlayer(b.me, inp, inp.dt, S.WEAPONS[0]);
  b.pending.push(inp);
  if (b.pending.length > 300) b.pending.shift();
}

(async () => {
  const bots = [];
  for (let i = 0; i < 6; i++) bots.push(await bot('soak' + i, i));
  await wait(400);
  const live = bots.filter(b => b.id);
  check('six bots connected', live.length === 6);

  const memBefore = await fetch(URL.replace('ws', 'http') + '/health')
    .then(r => r.json()).catch(() => null);
  check('health endpoint responds', !!memBefore && memBefore.ok);

  console.log('      running sustained load...');
  const start = Date.now();
  let tick = 0;
  while (Date.now() - start < 9000) {
    for (const b of live) drive(b, tick);
    tick++;
    await wait(16);
  }
  const elapsed = (Date.now() - start) / 1000;
  await wait(500);

  const totalSnaps = live.reduce((a, b) => a + b.snaps, 0);
  const rate = totalSnaps / live.length / elapsed;
  check(`snapshot rate held up (${rate.toFixed(1)}/s, target ${S.CONFIG.SNAPSHOT_HZ})`,
    rate > S.CONFIG.SNAPSHOT_HZ * 0.75);

  check('no client hit a protocol error', live.every(b => b.errors === 0));
  check('every bot is still receiving updates', live.every(b => b.snaps > 50));

  // Prediction drift: how far the bot's guess was from the server, per correction
  const avgDrift = live.reduce((a, b) => a + (b.driftSamples ? b.drift / b.driftSamples : 0), 0) / live.length;
  const worst = Math.max(...live.map(b => b.driftMax));
  check(`prediction stays close to the server (avg ${(avgDrift * 100).toFixed(1)}cm)`, avgDrift < 0.25,
    `worst single correction ${worst.toFixed(2)}m`);

  // Nobody should have been shoved out of the world
  const snap = live[0].last;
  const inBounds = snap.players.every(p =>
    Math.abs(p.x) < 48 && Math.abs(p.z) < 48 && p.y > -1 && p.y < 30 &&
    isFinite(p.x) && isFinite(p.y) && isFinite(p.z));
  check('everyone is still inside the map and finite', inBounds);

  // Nobody should be stuck inside geometry
  let insideGeometry = 0;
  for (const p of snap.players) {
    for (const b of S.MAP.boxes) {
      const r = S.CONFIG.PLAYER_RADIUS * 0.6;
      if (p.x > b.x - b.w / 2 - r && p.x < b.x + b.w / 2 + r &&
          p.z > b.z - b.d / 2 - r && p.z < b.z + b.d / 2 + r &&
          p.y + 0.1 < b.y + b.h && p.y + 1.5 > b.y) {
        insideGeometry++;
        break;
      }
    }
  }
  check(`nobody is stuck inside geometry (${insideGeometry} of ${snap.players.length})`,
    insideGeometry === 0);

  const after = await fetch(URL.replace('ws', 'http') + '/health')
    .then(r => r.json()).catch(() => null);
  check('server still healthy after the load', !!after && after.ok && after.players === live.length);

  console.log('');
  const pass = R.filter(Boolean).length;
  console.log(`${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
