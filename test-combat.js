// Combat + capture-the-flag flow, driven through the real GameHost.
const S = require('./public/shared.js');
const { GameHost } = require('./public/game.js');
const { CONFIG, WEAPONS, MAP } = S;

const R = [];
const check = (n, ok, note) => { R.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : '')); };

function makeHost() {
  const outbox = [];
  const h = new GameHost({ send: (id, msg) => outbox.push({ id, msg }) });
  h.outbox = outbox;
  return h;
}
function two() {
  // Two players, forced onto opposite teams, both alive with spawn protection off.
  const h = makeHost();
  const A = h.join('Att', { team: 'a' }).id;
  const B = h.join('Vic', { team: 'b' }).id;
  for (const id of [A, B]) { const p = h.players.get(id); p.protectedUntil = 0; }
  return { h, A, B };
}
function giveWeapon(h, id, wid) { h.players.get(id).weapon = S.WEAPON_BY_ID[wid].index; }
function face(from, to) { return Math.atan2(from.x - to.x, -(from.z - to.z)); } // yaw so 'from' looks at 'to'... see note
// Place attacker at origin looking toward -Z, victim just ahead
function square(h, A, B, dist) {
  const a = h.players.get(A), b = h.players.get(B);
  a.x = 0; a.z = 0; a.y = 0; a.yaw = 0; a.pitch = 0;      // faces -Z
  b.x = 0; b.z = -dist; b.y = 0; b.yaw = Math.PI;         // faces +Z (back at A)
}
function inputMsg(h, id, over) {
  const p = h.players.get(id);
  h.handle(id, Object.assign({
    type: 'input', seq: (p._seq = (p._seq || 0) + 1), dt: 1/60,
    forward: 0, right: 0, jumpEdge: false, crouch: false, sprint: false,
    attack: false, block: false, use: false, yaw: p.yaw, pitch: p.pitch
  }, over));
}
function wait(h, ms) {
  // The host stamps events with Date.now(), so let real time pass between ticks.
  const end = Date.now() + ms;
  h.tick();
  while (Date.now() < end) { for (let i = 0; i < 5000; i++) {} h.tick(); }
  h.tick();
}

console.log('--- melee wind-up ---');
{
  const { h, A, B } = two();
  giveWeapon(h, A, 'sword');
  square(h, A, B, 2);
  const vic = h.players.get(B);
  const hp0 = vic.health;
  // press attack once
  inputMsg(h, A, { attack: true }); h.tick();
  const w = S.WEAPON_BY_ID.sword;
  check('a swing does not land instantly (wind-up)', h.players.get(B).health === hp0, 'hp ' + h.players.get(B).health);
  // wait out the wind-up
  wait(h, w.windupMs + 40);
  check('the swing lands after its wind-up', h.players.get(B).health < hp0, 'hp ' + h.players.get(B).health);
}
{
  const { h, A, B } = two();
  giveWeapon(h, A, 'sword');
  square(h, A, B, 2);
  const before = h.players.get(A).stamina;
  inputMsg(h, A, { attack: true }); h.tick();
  check('swinging costs stamina', h.players.get(A).stamina < before);
}
{
  const { h, A, B } = two();
  giveWeapon(h, A, 'sword');
  square(h, A, B, 12);       // far out of reach
  const hp0 = h.players.get(B).health;
  inputMsg(h, A, { attack: true }); wait(h, 400);
  check('a swing at nothing hits nothing', h.players.get(B).health === hp0);
}

console.log('\n--- blocking ---');
{
  const { h, A, B } = two();
  giveWeapon(h, A, 'sword');
  giveWeapon(h, B, 'sword');
  square(h, A, B, 2);
  // B holds block, facing A
  const hpBlockStart = h.players.get(B).health;
  // start A's swing, and have B blocking the whole time (real time must pass)
  inputMsg(h, A, { attack: true });
  const blockEnd = Date.now() + 400;
  while (Date.now() < blockEnd) { inputMsg(h, B, { block: true }); h.tick(); for (let i = 0; i < 3000; i++) {} }
  const dmgBlocked = hpBlockStart - h.players.get(B).health;

  // now the same with no block
  const { h: h2, A: A2, B: B2 } = two();
  giveWeapon(h2, A2, 'sword'); giveWeapon(h2, B2, 'sword');
  square(h2, A2, B2, 2);
  const hp2 = h2.players.get(B2).health;
  inputMsg(h2, A2, { attack: true }); wait(h2, 400);
  const dmgOpen = hp2 - h2.players.get(B2).health;

  check(`blocking cuts damage (${dmgBlocked} vs ${dmgOpen} open)`, dmgBlocked < dmgOpen);
  check('blocking drains the blocker\'s stamina', h.players.get(B).stamina < CONFIG.MAX_STAMINA);
}

console.log('\n--- ranged ---');
{
  const { h, A, B } = two();
  giveWeapon(h, A, 'bow');
  // A at origin aiming down -Z, B directly downrange and close enough to hit fast
  const a = h.players.get(A), b = h.players.get(B);
  a.x = 0; a.z = 0; a.y = 0; a.yaw = 0; a.pitch = 0;
  b.x = 0; b.z = -6; b.y = 0;
  const hp0 = b.health;
  inputMsg(h, A, { attack: true }); h.tick();
  check('loosing an arrow spawns a projectile', h.projectiles.length === 1);
  wait(h, 400);
  check('the arrow damages a target downrange', h.players.get(B).health < hp0, 'hp ' + h.players.get(B).health);
}
{
  const { h, A } = two();
  giveWeapon(h, A, 'bow');
  const p = h.players.get(A);
  inputMsg(h, A, { attack: true }); h.tick();
  inputMsg(h, A, { attack: true }); h.tick();   // immediate second press
  check('the bow respects its cooldown (no double-loose)', h.projectiles.length === 1);
}

console.log('\n--- kills and respawn ---');
{
  const { h, A, B } = two();
  giveWeapon(h, A, 'axe');
  square(h, A, B, 2);
  h.players.get(B).health = 10;
  h.outbox.length = 0;
  inputMsg(h, A, { attack: true }); wait(h, S.WEAPON_BY_ID.axe.windupMs + 60);
  check('a lethal blow kills the victim', !h.players.get(B).alive);
  const killMsg = h.outbox.find(e => e.msg.type === 'kill');
  check('a kill is broadcast', !!killMsg);
  check('the killer is credited', h.players.get(A).kills === 1);
  check('the victim\'s death is counted', h.players.get(B).deaths === 1);
  // respawn after the timer
  wait(h, CONFIG.RESPAWN_MS + 100);
  check('the victim respawns', h.players.get(B).alive);
  check('respawn returns you to fists', h.players.get(B).weapon === S.FISTS);
  check('respawn restores full health', h.players.get(B).health === CONFIG.MAX_HEALTH);
}

console.log('\n--- spawn protection ---');
{
  const h = makeHost();
  const A = h.join('att', { team: 'a' }).id;
  const B = h.join('fresh', { team: 'b' }).id;
  h.players.get(A).protectedUntil = 0;           // attacker not protected
  giveWeapon(h, A, 'axe');
  square(h, A, B, 2);
  const hp0 = h.players.get(B).health;            // B still has spawn protection
  inputMsg(h, A, { attack: true }); wait(h, 400);
  check('a freshly-spawned player cannot be hit', h.players.get(B).health === hp0);
}

console.log('\n--- friendly fire is off ---');
{
  const h = makeHost();
  const A = h.join('m1', { team: 'a' }).id;
  const C = h.join('m2', { team: 'a' }).id;   // same team
  for (const id of [A, C]) h.players.get(id).protectedUntil = 0;
  giveWeapon(h, A, 'axe');
  const a = h.players.get(A), c = h.players.get(C);
  a.x = 0; a.z = 0; a.yaw = 0; c.x = 0; c.z = -2; c.y = 0;
  const hp0 = c.health;
  inputMsg(h, A, { attack: true }); wait(h, 400);
  check('you cannot hit a team-mate', h.players.get(C).health === hp0);
}

console.log('\n--- capture the flag ---');
{
  // Full capture loop: B (azure) grabs crimson... no - classic: you take the ENEMY flag.
  // Let A (crimson) take the azure flag and bring it home.
  const h = makeHost();
  const A = h.join('runner', { team: 'a' }).id;
  h.players.get(A).protectedUntil = 0;
  const p = h.players.get(A);

  // Walk onto the enemy (b) flag
  p.x = MAP.flags.b.x; p.z = MAP.flags.b.z; p.y = 0;
  h.outbox.length = 0;
  h.tick();
  check('touching the enemy flag picks it up', p.carrying === 'b');
  const taken = h.outbox.find(e => e.msg.type === 'flag' && e.msg.event === 'taken');
  check('the pickup is broadcast', !!taken);

  // Carry it home to your own stand (own flag is home, so it should score)
  p.x = MAP.flags.a.x; p.z = MAP.flags.a.z;
  h.outbox.length = 0;
  h.tick();
  check('carrying the enemy flag home scores', h.match.scores.a === 1, JSON.stringify(h.match.scores));
  check('the captor is credited', h.players.get(A).captures === 1);
  check('the enemy flag returns home after a capture', h.flags.b.state === 'home');
}
{
  // Classic rule: cannot score while your own flag is away from home.
  const h = makeHost();
  const A = h.join('runner', { team: 'a' }).id;
  const E = h.join('thief', { team: 'b' }).id;
  h.players.get(A).protectedUntil = 0; h.players.get(E).protectedUntil = 0;
  // Enemy has taken OUR flag (a) - it is not home
  h.flags.a.state = 'carried'; h.flags.a.carrier = E; h.players.get(E).carrying = 'a';
  // A carries the enemy flag home
  const p = h.players.get(A);
  p.carrying = 'b'; h.flags.b.state = 'carried'; h.flags.b.carrier = A;
  p.x = MAP.flags.a.x; p.z = MAP.flags.a.z; p.y = 0;
  h.tick();
  check('you cannot score while your own flag is out', h.match.scores.a === 0);
}
{
  // Returning your own dropped flag by touching it
  const h = makeHost();
  const A = h.join('defender', { team: 'a' }).id;
  h.players.get(A).protectedUntil = 0;
  h.flags.a.state = 'dropped'; h.flags.a.x = 10; h.flags.a.z = 10; h.flags.a.droppedAt = Date.now();
  const p = h.players.get(A); p.x = 10; p.z = 10; p.y = 0;
  h.tick();
  check('touching your dropped flag returns it', h.flags.a.state === 'home');
  check('the returner is credited', h.players.get(A).returns === 1);
}
{
  // Dropping the flag on death
  const h = makeHost();
  const A = h.join('carrier', { team: 'a' }).id;
  const K = h.join('killer', { team: 'b' }).id;
  h.players.get(A).protectedUntil = 0; h.players.get(K).protectedUntil = 0;
  const p = h.players.get(A);
  p.carrying = 'b'; h.flags.b.state = 'carried'; h.flags.b.carrier = A;
  giveWeapon(h, K, 'axe');
  const k = h.players.get(K);
  k.x = 0; k.z = 0; k.yaw = 0; p.x = 0; p.z = -2; p.y = 0; p.health = 5;
  h.outbox.length = 0;
  inputMsg(h, K, { attack: true }); wait(h, 400);
  check('killing a flag carrier drops the flag', h.flags.b.state === 'dropped' && !h.players.get(A).carrying);
}
{
  // Winning the match at the capture limit
  const h = makeHost();
  const A = h.join('winner', { team: 'a' }).id;
  h.players.get(A).protectedUntil = 0;
  h.match.scores.a = CONFIG.CAPTURES_TO_WIN - 1;
  const p = h.players.get(A);
  p.carrying = 'b'; h.flags.b.state = 'carried'; h.flags.b.carrier = A;
  p.x = MAP.flags.a.x; p.z = MAP.flags.a.z; p.y = 0;
  h.outbox.length = 0;
  h.tick();
  check('reaching the capture limit ends the match', h.match.phase === 'intermission');
  check('a match-end is broadcast with a winner', !!h.outbox.find(e => e.msg.type === 'match-end' && e.msg.winner === 'a'));
}

console.log('');
const pass = R.filter(Boolean).length;
console.log(`${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
