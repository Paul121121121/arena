// Teams and match flow.
// The shuffle is tested offline (thousands of runs, no waiting); the match
// cycle is tested against a live server running a deliberately short round.
const WebSocket = require('ws');
const S = require('./public/shared.js');
const URL = process.env.ARENA_URL || 'ws://localhost:3000';

const R = [];
const check = (n, ok, note) => {
  R.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : ''));
};
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('--- team shuffle ---');

const ids = [1, 2, 3, 4, 5, 6];
let alwaysBalanced = true, alwaysComplete = true;
const onTeamA = {}; ids.forEach(i => onTeamA[i] = 0);
const partitions = new Set();

for (let n = 0; n < 4000; n++) {
  const t = S.balancedShuffle(ids);
  const keys = Object.keys(t);
  if (keys.length !== ids.length) alwaysComplete = false;
  const a = keys.filter(k => t[k] === 'a');
  const b = keys.filter(k => t[k] === 'b');
  if (Math.abs(a.length - b.length) > 1) alwaysBalanced = false;
  a.forEach(k => onTeamA[k]++);
  partitions.add(a.sort().join(','));
}

check('everyone is assigned a team', alwaysComplete);
check('teams are always even', alwaysBalanced);
check(`the split actually varies (${partitions.size} distinct line-ups)`, partitions.size >= 15);

const rates = ids.map(i => onTeamA[i] / 4000);
check(`no player is biased toward one side (${rates.map(r => r.toFixed(2)).join(' ')})`,
  rates.every(r => r > 0.42 && r < 0.58));

// Odd player counts must still work
let oddOk = true;
for (const count of [1, 3, 5, 7, 11]) {
  const list = Array.from({ length: count }, (_, i) => i + 1);
  const t = S.balancedShuffle(list);
  const a = Object.values(t).filter(v => v === 'a').length;
  const b = Object.values(t).filter(v => v === 'b').length;
  if (Object.keys(t).length !== count || Math.abs(a - b) > 1) oddOk = false;
}
check('odd player counts split as evenly as possible', oddOk);
check('an empty server does not break the shuffle',
  Object.keys(S.balancedShuffle([])).length === 0);

console.log('\n--- match cycle ---');

function bot(name) {
  return new Promise(res => {
    const ws = new WebSocket(URL);
    const s = { ws, name, id: null, team: null, ev: [], teamHistory: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name })));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      s.ev.push(m);
      if (m.type === 'welcome') {
        s.id = m.id; s.team = m.team; s.cfg = m.config;
        s.teamHistory.push(m.team);
        res(s);
      }
      if (m.type === 'match-start' && m.teams && m.teams[s.id]) {
        s.team = m.teams[s.id];
        s.teamHistory.push(s.team);
      }
      if (m.type === 'ping-request') ws.send(JSON.stringify({ type: 'pong', t: m.t }));
    });
    ws.on('error', () => res(s));
    ws.on('close', () => res(s));
    setTimeout(() => res(s), 2000);
  });
}
const got = (b, t) => b.ev.filter(e => e.type === t);

(async () => {
  const bots = [];
  for (let i = 0; i < 6; i++) bots.push(await bot('m' + i));
  await wait(400);
  const live = bots.filter(b => b.id);
  check('six players in the match', live.length === 6);

  const roundMs = live[0].cfg.ROUND_MS;
  const interMs = live[0].cfg.INTERMISSION_MS;
  check(`server is running a short test round (${roundMs}ms)`, roundMs <= 20000,
    'set ARENA_ROUND_MS to run this quickly');

  // Wait for the clock to run out
  await wait(roundMs + 900);
  const ends = got(live[0], 'match-end');
  check('the match ends when the clock runs out', ends.length >= 1);
  if (ends.length) {
    const e = ends[0];
    check('the result reports both team scores',
      typeof e.scores.a === 'number' && typeof e.scores.b === 'number');
    check('the result includes per-player stats',
      Array.isArray(e.stats) && e.stats.length === 6 && 'k' in e.stats[0]);
    check('a winner or a draw is declared', e.winner === null || e.winner === 'a' || e.winner === 'b');
  }

  // ...and then a new one starts, with fresh teams
  await wait(interMs + 1200);
  const starts = got(live[0], 'match-start');
  check('a new match starts after the break', starts.length >= 1);

  if (starts.length) {
    const s0 = starts[starts.length - 1];
    check('scores reset for the new match', s0.scores.a === 0 && s0.scores.b === 0);
    check('every player is given a team at match start',
      live.every(b => s0.teams && s0.teams[b.id]));

    const a = live.filter(b => s0.teams[b.id] === 'a').length;
    const b2 = live.filter(b => s0.teams[b.id] === 'b').length;
    check(`the new teams are even (${a} vs ${b2})`, Math.abs(a - b2) <= 1);

    // Everyone should be back on their feet at the start of a match
    const resp = got(live[0], 'respawn');
    check('players are respawned for the new match', resp.length >= 1);

    // Positions must be back inside the correct base
    await wait(400);
    const snap = got(live[0], 'snapshot').pop();
    const inBase = live.every(bb => {
      const p = snap.players.find(x => x.id === bb.id);
      const team = s0.teams[bb.id];
      return p && (team === 'a' ? p.z < -20 : p.z > 20);
    });
    check('everyone respawns in their new base', inBase);
  }

  console.log('');
  const pass = R.filter(Boolean).length;
  console.log(`${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
