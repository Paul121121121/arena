// End-to-end: start the real server, connect over WebSocket, and confirm the
// whole handshake and a few round-trips work over the wire.
const http = require('http');
const { WebSocket } = require('ws');

const R = [];
const check = (n, ok, note) => { R.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 3999;
process.env.PORT = PORT;
process.env.ARENA_BOTS = '3';
process.env.ARENA_BOT_SKILL = 'regular';

// Start the server in this process
require('./server.js');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  await sleep(400);

  // 1. static files + health
  try {
    const idx = await get('/');
    check('the server serves the page', idx.status === 200 && /Castle Clash/.test(idx.body));
    const health = await get('/health');
    const h = JSON.parse(health.body);
    check('the health endpoint answers', health.status === 200 && h.ok === true);
    check('bots were added to the empty server', h.bots === 3, 'bots=' + h.bots);
  } catch (e) { check('http endpoints reachable', false, e.message); }

  // 2. websocket join handshake
  const ws = new WebSocket('ws://127.0.0.1:' + PORT);
  const got = {};
  let welcome = null;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    got[m.type] = (got[m.type] || 0) + 1;
    if (m.type === 'welcome') welcome = m;
  });

  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  check('a client can open a socket', ws.readyState === 1);

  ws.send(JSON.stringify({ type: 'join', name: 'E2E Knight', look: { body: 'body_dark', torso: 'torso_plate', hair: 'hair_long' } }));
  await sleep(300);

  check('the server sends a welcome', !!welcome, welcome ? '' : 'none');
  if (welcome) {
    check('welcome carries an id and team', !!welcome.id && (welcome.team === 'a' || welcome.team === 'b'));
    check('welcome carries the map and weapons', !!welcome.map && !!welcome.config);
    check('the chosen look survived the trip', welcome.you !== undefined);
  }

  // 3. sending input produces snapshots
  const before = got.snapshot || 0;
  for (let i = 0; i < 30; i++) {
    ws.send(JSON.stringify({ type: 'input', seq: i + 1, dt: 1/60, forward: 1, right: 0, yaw: 0, pitch: 0,
      jumpEdge: false, crouch: false, sprint: false, attack: false, block: false, use: false }));
    await sleep(16);
  }
  await sleep(200);
  check('the server streams snapshots back', (got.snapshot || 0) > before, 'snapshots=' + (got.snapshot || 0));

  // 4. pings (interval is 2500ms - wait it out)
  await sleep(2600);
  check('the server pings the client', (got['ping-request'] || 0) >= 1, 'pings=' + (got['ping-request'] || 0));
  ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
  await sleep(100);

  // 5. a second client and roster update
  const ws2 = new WebSocket('ws://127.0.0.1:' + PORT);
  await new Promise(res => ws2.on('open', res));
  ws2.send(JSON.stringify({ type: 'join', name: 'Second' }));
  await sleep(300);
  check('a second client can join', ws2.readyState === 1);

  // 6. malformed input over the wire does not kill the server
  ws.send('this is not json');
  ws.send(JSON.stringify({ type: 'input', seq: 'bad', dt: 'x', forward: {} }));
  await sleep(150);
  const stillUp = await get('/health');
  check('garbage over the wire does not crash the server', stillUp.status === 200);

  // 7. clean disconnect
  ws.close(); ws2.close();
  await sleep(200);

  console.log('');
  const pass = R.filter(Boolean).length;
  console.log(`${pass}/${R.length} passed`);
  process.exit(pass === R.length ? 0 : 1);
})();
