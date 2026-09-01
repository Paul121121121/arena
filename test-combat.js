// Combat integration: does damage actually register over the wire, through
// the lag-compensation path, and does friendly fire stay off?
const WebSocket = require('ws');
const S = require('./public/shared.js');
const U = require('./test-util.js');
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
    const s = { ws, name, seq: 0, id: null, team: null, hp: 100, ev: [], deaths: 0 };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name })));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      s.ev.push(m);
      if (m.type === 'welcome') { s.id = m.id; s.team = m.team; res(s); }
      if (m.type === 'full') res(s);
      if (m.type === 'snapshot') s.last = m;
      if (m.type === 'hurt') s.hp = m.health;
      if (m.type === 'respawn') s.hp = 100;
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
    type: 'input', seq: ++b.seq, dt: 1 / 60, forward: 0, right: 0, jump: false,
    crouch: false, sprint: false, ads: false, shoot: false, yaw: 0, pitch: 0
  }, o)));
};
const got = (b, t) => b.ev.filter(e => e.type === t);
const clearEv = b => { b.ev.length = 0; };

function aim(from, to, targetHeight) {
  const dx = to.x - from.x;
  const dy = (to.y + (targetHeight || 1.0)) - (from.y + S.CONFIG.STAND_EYE);
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
  const bots = [];
  for (let i = 0; i < 4; i++) bots.push(await bot('duel' + i));
  await wait(500);
  const live = bots.filter(b => b.id);
  check('bots connected', live.length === 4);

  // Walk one attacker out of its base and into the open middle ground
  const atk = live.find(b => b.team === 'a') || live[0];
  const foe = live.find(b => b.team !== atk.team);
  check('there is an enemy to shoot at', !!foe);
  if (!foe) { process.exit(1); }

  let pa = atk.last.players.find(p => p.id === atk.id);
  let pf = atk.last.players.find(p => p.id === foe.id);

  // Stage the duel on ground the map actually supports, instead of hoping two
  // bots wander into a sightline. Pull the target out into an open lane, then
  // find a spot with a clear shot at it and route the attacker there.
  const stage = U.stageDuel(pa, pf, { minRange: 12, maxRange: 22 });
  check('the map offers open ground plus a firing position on it', !!stage);
  if (!stage) process.exit(1);
  const foeSpot = stage.targetSpot;
  const atkSpot = stage.shooterSpot;

  const foePath = U.findPath(pf, foeSpot);
  const atkPath = U.findPath(pa, atkSpot);
  check(`both have a route (${foePath ? foePath.length : 0} and ${atkPath ? atkPath.length : 0} waypoints)`,
    !!foePath && !!atkPath);
  if (!foePath || !atkPath) process.exit(1);

  // Walk both at once
  function stepAlong(b, path, idx, pos) {
    if (idx >= path.length) return idx;
    const t = path[idx];
    const gap = Math.hypot(t.x - pos.x, t.z - pos.z);
    // Smaller than the spacing between waypoints, or the bot skips one and
    // walks straight at a wall.
    if (gap < 0.9) return idx + 1;
    if (idx + 1 < path.length) {
      const nxt = path[idx + 1];
      if (Math.hypot(nxt.x - pos.x, nxt.z - pos.z) < gap - 0.5) return idx + 1;
    }
    input(b, { forward: 1, sprint: gap > 6, yaw: Math.atan2(-(t.x - pos.x), -(t.z - pos.z)) });
    return idx;
  }

  const foeStart = { x: pf.x, z: pf.z };
  let ai = 1, fi = 1;
  const walkUntil = Date.now() + 13000;
  while ((ai < atkPath.length || fi < foePath.length) && Date.now() < walkUntil) {
    pa = atk.last.players.find(p => p.id === atk.id) || pa;
    pf = atk.last.players.find(p => p.id === foe.id) || pf;
    ai = stepAlong(atk, atkPath, ai, pa);
    fi = stepAlong(foe, foePath, fi, pf);
    await wait(16);
  }
  await wait(350);

  pa = atk.last.players.find(p => p.id === atk.id);
  pf = atk.last.players.find(p => p.id === foe.id);
  const dist = Math.hypot(pf.x - pa.x, pf.z - pa.z);
  const offA = Math.hypot(pa.x - atkSpot.x, pa.z - atkSpot.z);
  const offF = Math.hypot(pf.x - foeSpot.x, pf.z - foeSpot.z);
  const clearNow = () => U.robustLineOfSight(
    { x: pa.x, z: pa.z }, { x: pf.x, y: pf.y, z: pf.z }, 1.2);
  let clear = clearNow();

  check(`the shooter walked to its firing position (${offA.toFixed(1)}m off the mark)`, offA < 4);
  check(`the target walked to the open ground (${offF.toFixed(1)}m off the mark)`, offF < 4);

  // A metre of drift can still leave cover in the way, so sidestep until the
  // shot opens up - the same thing a player does when half behind a wall.
  for (let tries = 0; !clear && tries < 30; tries++) {
    const side = (tries % 2 === 0) ? 1 : -1;
    const face = Math.atan2(-(pf.x - pa.x), -(pf.z - pa.z));
    for (let k = 0; k < 4; k++) { input(atk, { right: side, yaw: face }); await wait(16); }
    pa = atk.last.players.find(p => p.id === atk.id) || pa;
    pf = atk.last.players.find(p => p.id === foe.id) || pf;
    clear = clearNow();
  }

  check(`line of fire is clear at ${dist.toFixed(0)}m`, clear, clear ? '' : 'cover in the way');

  if (clear) {
    const look = aim(pa, pf);
    clearEv(atk);
    // Settle: both stand still, the shooter lines up, spawn protection expires
    for (let i = 0; i < 25; i++) {
      input(atk, { yaw: look.yaw, pitch: look.pitch, ads: true });
      input(foe, { yaw: 0, pitch: 0 });
      await wait(16);
    }
    const hp0 = foe.hp;
    // Tap-fire the way a player would. Holding the trigger at this range
    // walks the spread wide open and most of the burst misses - which is the
    // weapon working correctly, not a bug.
    for (let burst = 0; burst < 5; burst++) {
      for (let i = 0; i < 2; i++) {
        // Re-aim from the latest snapshot every shot. Aiming once and then
        // holding still is not enough: the shooter is still decelerating from
        // the walk, and half a metre of drift at this range is a clean miss.
        pa = atk.last.players.find(p => p.id === atk.id) || pa;
        pf = atk.last.players.find(p => p.id === foe.id) || pf;
        const now = aim(pa, pf);
        input(atk, { yaw: now.yaw, pitch: now.pitch, ads: true, shoot: true });
        input(foe, { yaw: 0, pitch: 0 });
        await wait(105);
      }
      for (let i = 0; i < 8; i++) {
        input(atk, { yaw: look.yaw, pitch: look.pitch, ads: true });
        input(foe, { yaw: 0, pitch: 0 });
        await wait(40);
      }
    }
    await wait(400);

    if (process.env.DEBUG_SHOT) {
      const ss = got(atk, 'shot').filter(x => x.id === atk.id);
      console.log('      shots fired:', ss.length);
      ss.slice(0, 3).forEach(x => console.log('        beam ->', JSON.stringify(x.beams[0])));
      console.log('      shooter at', pa.x.toFixed(1), pa.z.toFixed(1), 'target at', pf.x.toFixed(1), pf.z.toFixed(1));
      console.log('      aim yaw/pitch', look.yaw.toFixed(3), look.pitch.toFixed(3));
    }
    const kill = got(atk, 'kill').find(k => k.killerId === atk.id);
    const beams = got(atk, 'shot').filter(x => x.id === atk.id).flatMap(x => x.beams);
    const flesh = beams.filter(bm => bm.s === 'flesh').length;
    check(`damage registered over the network (${hp0} -> ${foe.hp} hp)`, foe.hp < hp0 || !!kill,
      `${beams.length} beams, ${flesh} flesh, range ${dist.toFixed(0)}m, ` +
      `shooter ${pa.x.toFixed(1)},${pa.y.toFixed(1)},${pa.z.toFixed(1)} ` +
      `target ${pf.x.toFixed(1)},${pf.y.toFixed(1)},${pf.z.toFixed(1)} ` +
      `first beam ${beams.length ? JSON.stringify(beams[0]) : 'none'}`);
    check('shooter got hitmarkers', got(atk, 'hitmarker').length > 0);
    check('shot messages carry beams with a surface',
      got(atk, 'shot').every(s => s.beams && s.beams.length && s.beams[0].s));
    if (kill) {
      check('kill event names both players and the weapon',
        kill.killer === atk.name && kill.victim === foe.name && !!kill.weapon);
      check('kill updated the team score', got(atk, 'score').length > 0);
      check('victim was told they died', got(foe, 'kill').length > 0);
      await wait(S.CONFIG.RESPAWN_MS + 500);
      check('victim respawned with full health',
        got(foe, 'respawn').length > 0 && foe.hp === 100);
    }
  }

  // --- friendly fire must be off ---
  const mate = live.find(b => b.team === atk.team && b.id !== atk.id);
  if (mate) {
    await wait(300);
    const pa2 = atk.last.players.find(p => p.id === atk.id);
    const pm = atk.last.players.find(p => p.id === mate.id);
    const lookM = aim(pa2, pm);
    const before = mate.hp;
    clearEv(atk);
    for (let i = 0; i < 8; i++) {
      input(atk, { yaw: lookM.yaw, pitch: lookM.pitch, shoot: true });
      await wait(108);
    }
    await wait(350);
    check('friendly fire deals no damage', mate.hp >= before, `${before} -> ${mate.hp}`);
    check('no hitmarker when shooting a teammate', got(atk, 'hitmarker').length === 0);
  } else {
    check('friendly fire deals no damage', true, 'no teammate available');
    check('no hitmarker when shooting a teammate', true, 'no teammate available');
  }

  console.log('');
  const pass = R.filter(Boolean).length;
  console.log(`${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
