// Soak test - run a full 6-bot match hard for a while and make sure nothing
// drifts, leaks, or throws. This is the test that catches the slow bugs.
const S = require('./public/shared.js');
const { GameHost } = require('./public/game.js');
const Bots = require('./public/bots.js');
const { CONFIG } = S;

const R = [];
const check = (n, ok, note) => { R.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : '')); };

console.log('Running a hard 6-bot soak (this takes a few seconds)...');

let sent = 0;
const h = new GameHost({
  send: () => { sent++; },
  config: { ROUND_MS: 4000, INTERMISSION_MS: 800, CAPTURES_TO_WIN: 3 }
});
// One human keeps the match loop cycling (an all-bot room correctly idles).
const human = h.join('watcher', { team: 'a' });
const bots = Bots.spawnBots(h, 5, 'veteran');

let threw = null, ticks = 0, matchStarts = 0, matchEnds = 0, captures = 0, kills = 0;
const origBroadcast = h.broadcast.bind(h);
h.broadcast = function (msg) {
  if (msg.type === 'match-start') matchStarts++;
  if (msg.type === 'match-end') matchEnds++;
  if (msg.type === 'capture') captures++;
  if (msg.type === 'kill') kills++;
  return origBroadcast(msg);
};

const runFor = 6000;                    // 6 seconds of wall-clock play
const end = Date.now() + runFor;
try {
  while (Date.now() < end) {
    Bots.driveBots(h, bots, 1 / 60);
    h.tick();
    ticks++;
    // small real-time gap so timers advance without pinning a core forever
    const g = Date.now() + 1; while (Date.now() < g) {}
  }
} catch (e) { threw = e; }

check('the soak never threw', !threw, threw ? threw.message : '');
check(`it ran a lot of ticks (${ticks})`, ticks > 200);
check(`matches cycle over time (${matchEnds} ends, ${matchStarts} restarts)`, matchEnds >= 1 && matchStarts >= 1);
console.log(`   observed: ${kills} kills, ${captures} captures, ${matchEnds} match ends`);

// Everything still finite and in-bounds
let bad = null;
for (const p of h.players.values()) {
  if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z) || !isFinite(p.health)) bad = p.name + ' non-finite';
  if (Math.abs(p.x) > S.MAP.width * 1.5 || Math.abs(p.z) > S.MAP.depth * 1.5) bad = p.name + ' out of bounds';
  if (p.y < -10) bad = p.name + ' fell through the world';
}
check('all players finite and in-bounds after the soak', !bad, bad || '');

// Projectiles must not pile up forever (they expire)
check(`projectiles do not accumulate unbounded (${h.projectiles.length} live)`, h.projectiles.length < 60);

// History buffers used for lag comp must be trimmed, not grow forever
let maxHist = 0;
for (const p of h.players.values()) maxHist = Math.max(maxHist, p.history.length);
check(`lag-comp history stays bounded (max ${maxHist} samples)`, maxHist < 200);

// Input queues drained each tick, not backing up
let maxQ = 0;
for (const p of h.players.values()) maxQ = Math.max(maxQ, p.inputQueue.length);
check(`input queues stay drained (max ${maxQ})`, maxQ < 80);

// Scores never negative or NaN
check('scores stay valid', isFinite(h.match.scores.a) && isFinite(h.match.scores.b) && h.match.scores.a >= 0 && h.match.scores.b >= 0);

// Teams stayed roughly balanced through reshuffles
let a = 0, b = 0; for (const p of h.players.values()) p.team === 'a' ? a++ : b++;
check(`teams still balanced after reshuffles (${a} vs ${b})`, Math.abs(a - b) <= 1);

// A snapshot is still well-formed at the end
const snap = h.snapshot(Date.now());
check('a final snapshot is well-formed',
  snap.players.length === 6 && snap.flags && Array.isArray(snap.peds) && Array.isArray(snap.kits));

console.log('');
const pass = R.filter(Boolean).length;
console.log(`${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
