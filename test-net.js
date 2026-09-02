// Integration tests - drive the real GameHost the way the network would.
// Messages are captured instead of sent over a socket.
const S = require('./public/shared.js');
const { GameHost } = require('./public/game.js');
const { CONFIG, WEAPONS, MAP } = S;

const R = [];
const check = (n, ok, note) => { R.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : '')); };

function makeHost() {
  const outbox = [];
  const host = new GameHost({ send: (id, msg) => outbox.push({ id, msg }) });
  host.outbox = outbox;
  return host;
}
function drain(host) { const o = host.outbox.slice(); host.outbox.length = 0; return o; }
function msgsTo(host, id, type) { return host.outbox.filter(e => e.id === id && e.msg.type === type).map(e => e.msg); }

function input(host, id, over) {
  const p = host.players.get(id);
  host.handle(id, Object.assign({
    type: 'input', seq: (p._seq = (p._seq || 0) + 1), dt: 1/60,
    forward: 0, right: 0, jumpEdge: false, crouch: false, sprint: false,
    attack: false, block: false, use: false, yaw: p.yaw, pitch: p.pitch
  }, over));
}
// Teleport a player (tests are about rules, not pathfinding)
function place(host, id, x, z, yaw) { const p = host.players.get(id); p.x = x; p.z = z; p.y = 0; if (yaw !== undefined) p.yaw = yaw; }

console.log('--- joining ---');
{
  const h = makeHost();
  const j = h.join('Alice', {});
  check('join returns id, welcome and player', j && j.id && j.welcome && j.player);
  check('welcome carries the map and weapons', j.welcome.map && j.welcome.config && j.welcome.lookOptions);
  check('a fresh player has full health', j.player.health === CONFIG.MAX_HEALTH);
  check('a fresh player holds only fists', j.player.weapon === S.FISTS);
  check('a fresh player has a team', j.player.team === 'a' || j.player.team === 'b');
}
{
  const h = makeHost();
  h.join('a'); h.join('b'); h.join('c'); h.join('d');
  let a = 0, b = 0; for (const p of h.players.values()) p.team === 'a' ? a++ : b++;
  check(`teams stay balanced as people join (${a} vs ${b})`, Math.abs(a - b) <= 1);
}
{
  const h = makeHost();
  for (let i = 0; i < CONFIG.MAX_PLAYERS; i++) h.join('p' + i);
  const over = h.join('one-too-many');
  check(`the room caps at ${CONFIG.MAX_PLAYERS}`, over === null && h.players.size === CONFIG.MAX_PLAYERS);
}
{
  const h = makeHost();
  const j = h.join('<script>bad&"name"', {});
  check('names are sanitised', !/[<>&"']/.test(j.player.name), j.player.name);
}
{
  const h = makeHost();
  const j = h.join('x', { look: { body: 'nonsense', torso: 'torso_plate', hair: 'evil' } });
  check('bad look choices fall back to valid ones',
    j.player.look.body === 'body_light' && j.player.look.torso === 'torso_plate' && j.player.look.hair === 'hair_messy');
}

console.log('\n--- weapon pedestals ---');
{
  const h = makeHost();
  const j = h.join('picker'); const id = j.id;
  const ped = h.pedestals.find(p => p.weapon === 'sword');
  place(h, id, ped.x, ped.z);
  drain(h);
  input(h, id, { use: true }); h.tick();
  const p = h.players.get(id);
  check('E on a pedestal swaps your weapon', p.weapon === S.WEAPON_BY_ID.sword.index, WEAPONS[p.weapon].id);
  check('the pedestal goes on cooldown', !ped.ready);
  check('you are told what you picked up', msgsTo(h, id, 'picked').length === 1);
}
{
  const h = makeHost();
  const j = h.join('faraway'); const id = j.id;
  place(h, id, -20, -15);   // verified empty, standable
  const before = h.players.get(id).weapon;
  input(h, id, { use: true }); h.tick();
  check('E in open space does nothing', h.players.get(id).weapon === before);
}

console.log('\n--- medkits ---');
{
  const h = makeHost();
  const j = h.join('hurt'); const id = j.id; const p = h.players.get(id);
  p.health = 40;
  const kit = h.medkits[0];
  place(h, id, kit.x, kit.z);
  drain(h);
  h.tick();
  check('walking over a medkit heals you', h.players.get(id).health > 40);
  check('the medkit is consumed', !h.medkits[0].ready);
  check('you are told you healed', msgsTo(h, id, 'healed').length >= 1);
}
{
  const h = makeHost();
  const j = h.join('full'); const id = j.id;
  const kit = h.medkits[0]; place(h, id, kit.x, kit.z);
  h.tick();
  check('a full-health player does not waste a medkit', h.medkits[0].ready);
}

console.log('\n--- anti-cheat ---');
{
  const h = makeHost();
  const j = h.join('speedhacker'); const id = j.id;
  const start = { x: h.players.get(id).x, z: h.players.get(id).z };
  // Flood 300 max-move inputs in one tick - a client trying to move 300x
  for (let i = 0; i < 300; i++) input(h, id, { forward: 1, dt: CONFIG.MAX_INPUT_DT });
  h.tick();
  const p = h.players.get(id);
  const moved = Math.hypot(p.x - start.x, p.z - start.z);
  check(`input flooding cannot teleport you (moved ${moved.toFixed(1)}m)`, moved < 3);
}
{
  const h = makeHost();
  const j = h.join('liar'); const id = j.id;
  const before = h.players.get(id).x;
  host_survives = true;
  try {
    h.handle(id, { type: 'input', seq: 1, dt: 999, forward: 50, right: 'x', yaw: NaN, pitch: Infinity });
    h.handle(id, { type: 'nonsense' });
    h.handle(id, null);
    h.handle(id, { type: 'input' });
    h.tick();
  } catch (e) { host_survives = false; }
  check('malformed messages do not crash the host', host_survives);
  check('a huge dt is clamped', isFinite(h.players.get(id).x));
}
{
  const h = makeHost();
  const j = h.join('replayer'); const id = j.id;
  input(h, id, { forward: 1, dt: 1/60 }); h.tick();
  const after1 = h.players.get(id).z;
  // resend an old seq - should be ignored
  const p = h.players.get(id);
  h.handle(id, { type: 'input', seq: 1, dt: 1/60, forward: 1, yaw: 0, pitch: 0 });
  h.tick();
  check('stale input sequences are ignored', Math.abs(h.players.get(id).z - after1) < 0.05);
}

console.log('');
const pass = R.filter(Boolean).length;
console.log(`${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
