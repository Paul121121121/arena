// Runs the whole suite. Boots its own server on a spare port, runs each file
// against it, then shuts it down. Just: npm test
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.TEST_PORT || 3111;
const URL = 'ws://localhost:' + PORT;

const SUITES = [
  { file: 'test-core.js',   name: 'Core: map, movement, weapons, hit detection', server: false },
  { file: 'test-net.js',    name: 'Network: joining, teams, weapons, anti-cheat', server: true },
  { file: 'test-combat.js', name: 'Combat: damage, kills, friendly fire',         server: true },
  { file: 'test-teams.js',  name: 'Teams: shuffle and match cycle',               server: true,
    env: { ARENA_ROUND_MS: '5000', ARENA_INTERMISSION_MS: '2500' } },
  { file: 'test-assets.js', name: 'Models: files, fitting and fallbacks',         server: false },
  { file: 'test-bots.js',   name: 'Bots and offline mode',                        server: false },
  { file: 'test-soak.js',   name: 'Soak: sustained load and prediction drift',    server: true }
];

function startServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT) }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let ready = false;
    srv.stdout.on('data', d => {
      if (!ready && String(d).includes('Arena on')) { ready = true; resolve(srv); }
    });
    srv.stderr.on('data', d => process.stderr.write('  server: ' + d));
    srv.on('exit', c => { if (!ready) reject(new Error('server exited early, code ' + c)); });
    setTimeout(() => { if (!ready) reject(new Error('server did not start in time')); }, 8000);
  });
}

function runSuite(file, extraEnv) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(__dirname, file)], {
      env: Object.assign({}, process.env, { ARENA_URL: URL }, extraEnv || {}),
      stdio: 'inherit'
    });
    p.on('exit', code => resolve(code === 0));
  });
}

// Optional filter: `node test-all.js combat teams` runs just those suites.
const filter = process.argv.slice(2);
const selected = filter.length
  ? SUITES.filter(s => filter.some(f => s.file.includes(f)))
  : SUITES;

(async () => {
  const results = [];

  for (const s of selected) {
    console.log('\n' + '='.repeat(66));
    console.log(s.name);
    console.log('='.repeat(66));

    let srv = null;
    if (s.server) {
      try {
        srv = await startServer(s.env);
      } catch (e) {
        console.log('  could not start the server: ' + e.message);
        results.push([s.name, false]);
        continue;
      }
    }

    const ok = await runSuite(s.file, s.env);
    results.push([s.name, ok]);

    if (srv) {
      srv.kill();
      await new Promise(r => setTimeout(r, 400));
    }
  }

  console.log('\n' + '='.repeat(66));
  results.forEach(([n, ok]) => console.log((ok ? '  ok    ' : '  FAIL  ') + n));
  const passed = results.filter(r => r[1]).length;
  console.log('\n  ' + passed + '/' + results.length + ' suites passed\n');
  process.exit(passed === results.length ? 0 : 1);
})();
