// Bots and offline mode.
//
// Offline mode is the same GameHost the server runs, wrapped in something that
// pretends to be a WebSocket. So these tests drive it exactly the way the
// browser does - JSON in, JSON out - and check a real match plays out.
const { GameHost } = require('./public/game.js');
const Bots = require('./public/bots.js');
const Offline = require('./public/offline.js');
const S = require('./public/shared.js');
const N = require('./public/nav.js');

const R = [];
const check = (n, ok, note) => {
  R.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : ''));
};
const wait = ms => new Promise(r => setTimeout(r, ms));

// Node has no `performance` before we touch it in some versions; offline.js
// uses it for its tick clock.
if (typeof performance === 'undefined') global.performance = { now: () => Date.now() };

(async () => {
  console.log('--- bots ---');

  {
    const seen = [];
    const host = new GameHost({ send: (id, m) => seen.push(m) });
    const bots = Bots.spawnBots(host, 6, 'regular');

    check(`six bots join (${bots.length})`, bots.length === 6);
    check('bots are marked as bots', [...host.players.values()].every(p => p.bot));
    check('bots are split evenly',
      Math.abs([...host.players.values()].filter(p => p.team === 'a').length - 3) <= 1);
    check('bots get a spread of weapons',
      new Set([...host.players.values()].map(p => p.weapon)).size >= 3);
    check('every skill level is defined',
      ['recruit', 'regular', 'veteran'].every(k => Bots.SKILLS[k]));

    // Bots must not be given any advantage the simulation would not give a player
    const p = [...host.players.values()][0];
    check('bots have normal health', p.health === S.CONFIG.MAX_HEALTH);
    check('bots have normal magazines', p.loadout[p.weapon].ammo === S.WEAPONS[p.weapon].mag);

    // A bot with nothing in sight should produce movement input
    const input = Bots.think(host, bots[0], 1 / 60);
    check('a bot produces a valid input message',
      input && input.type === 'input' && typeof input.seq === 'number' &&
      isFinite(input.yaw) && isFinite(input.pitch));
    check('bot input respects the same limits as a player',
      Math.abs(input.forward) <= 1 && Math.abs(input.right) <= 1 &&
      Math.abs(input.pitch) <= 1.54);
  }

  console.log('\n--- bots actually play ---');

  {
    const events = [];
    const host = new GameHost({ send: (id, m) => events.push(m) });
    const bots = Bots.spawnBots(host, 6, 'veteran');
    const startPos = [...host.players.values()].map(p => ({ id: p.id, x: p.x, z: p.z }));

    const tickMs = 1000 / S.CONFIG.TICK_HZ;
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      Bots.driveBots(host, bots, tickMs / 1000);
      host.tick();
      await wait(tickMs);
    }

    // Every kill is broadcast to all six, so divide through
    const kills = events.filter(e => e.type === 'kill').length / 6;
    const shots = events.filter(e => e.type === 'shot').length / 6;

    check(`bots move around the map`, [...host.players.values()].some(p => {
      const s = startPos.find(q => q.id === p.id);
      return Math.hypot(p.x - s.x, p.z - s.z) > 15;
    }));
    check(`bots shoot (${Math.round(shots)} shots)`, shots > 5);
    check(`bots kill each other (${Math.round(kills)} kills)`, kills >= 1);
    check('the scoreboard adds up',
      host.match.scores.a + host.match.scores.b === Math.round(kills));

    // Nobody wandered out of the world or into a wall
    const snap = host.snapshot();
    check('every bot is in bounds and finite',
      snap.players.every(p => isFinite(p.x) && isFinite(p.z) &&
        Math.abs(p.x) < 48 && Math.abs(p.z) < 48 && p.y >= -1 && p.y < 30));

    let stuck = 0;
    for (const p of snap.players) {
      if (N.blockedAt(p.x, p.z) && p.y < 0.6) stuck++;
    }
    check(`no bot is standing inside a wall (${stuck})`, stuck === 0);

    // Friendly fire must be off for bots too
    const teamKills = events.filter(e => e.type === 'kill' && e.killerTeam === e.victimTeam).length;
    check('bots never kill their own team', teamKills === 0);
  }

  console.log('\n--- difficulty means something ---');

  {
    const recruit = Bots.SKILLS.recruit, veteran = Bots.SKILLS.veteran;
    check('veterans react faster than recruits', veteran.reaction < recruit.reaction);
    check('veterans aim tighter than recruits', veteran.aimError < recruit.aimError);
    check('veterans turn faster than recruits', veteran.turnRate > recruit.turnRate);
    check('difficulty changes behaviour, not stats',
      !('health' in veteran) && !('damage' in veteran));
  }

  console.log('\n--- offline mode ---');

  {
    const received = [];
    const sock = Offline.createLocalSocket({ bots: 5, skill: 'regular' });
    sock.onmessage = e => received.push(JSON.parse(e.data));

    let opened = false;
    sock.onopen = () => { opened = true; sock.send(JSON.stringify({ type: 'join', name: 'player' })); };

    await wait(200);
    check('the local socket opens like a real one', opened && sock.readyState === 1);

    const welcome = received.find(m => m.type === 'welcome');
    check('it sends a welcome', !!welcome);
    check('the welcome says it is offline', welcome && welcome.offline === true);
    check('the welcome carries the map and weapons',
      welcome && welcome.map.boxes.length > 60 && welcome.weapons.length === 5);
    check(`the room is filled with bots (${welcome ? welcome.players.length : 0} players)`,
      welcome && welcome.players.length === 6);
    check('the human is not marked as a bot',
      welcome && welcome.players.find(p => p.id === welcome.id).bot === false);

    // Drive it the way the browser does
    let seq = 0;
    const send = o => sock.send(JSON.stringify(Object.assign({
      type: 'input', seq: ++seq, dt: 1 / 60, forward: 0, right: 0, jump: false,
      crouch: false, sprint: false, ads: false, shoot: false, yaw: 0, pitch: 0
    }, o)));

    received.length = 0;
    for (let i = 0; i < 120; i++) { send({ forward: 1, sprint: true, yaw: 0 }); await wait(16); }
    await wait(300);

    const snaps = received.filter(m => m.type === 'snapshot');
    check(`snapshots arrive offline (${snaps.length})`, snaps.length > 20);

    const last = snaps[snaps.length - 1];
    const me = last.players.find(p => p.id === welcome.id);
    check('the player moved', me && Math.abs(me.z - welcome.you.z) > 5);
    check('snapshots include the bots', last.players.length === 6);
    check('the server acknowledges input sequence numbers', me.seq > 50);

    // Shooting works with no network at all
    received.length = 0;
    for (let i = 0; i < 6; i++) { send({ shoot: true, yaw: 0 }); await wait(110); }
    await wait(200);
    const shots = received.filter(m => m.type === 'shot' && m.id === welcome.id);
    const ammo = received.filter(m => m.type === 'ammo');
    check(`firing works offline (${shots.length} shots)`, shots.length > 0);
    check('ammo counts down', ammo.length > 0 && ammo[ammo.length - 1].ammo < 30);
    check('shots carry beams with a surface',
      shots.every(s => s.beams.length >= 1 && s.beams[0].s));

    // Weapon switching and reloading
    received.length = 0;
    sock.send(JSON.stringify({ type: 'switch', slot: 3 }));
    await wait(150);
    const wep = received.find(m => m.type === 'weapon');
    check('weapon switching works offline', wep && wep.slot === 3);

    sock.close();
    check('closing the local socket stops it', sock.readyState === 3);
  }

  console.log('\n--- offline and online share one rulebook ---');

  {
    // If these two ever diverge, offline mode stops being practice for online.
    const a = new GameHost({ send: () => {} });
    const b = new GameHost({ send: () => {} });
    check('both hosts start with the same config',
      JSON.stringify(a.config) === JSON.stringify(b.config));
    check('offline mode uses the server GameHost, not a copy',
      Offline.createLocalSocket({ bots: 1 })._host instanceof GameHost);
  }

  console.log('');
  const pass = R.filter(Boolean).length;
  console.log(`${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
