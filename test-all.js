// Runs every test suite in turn and reports a combined total.
const { execFileSync } = require('child_process');

const suites = [
  ['core',    'test-core.js'],
  ['net',     'test-net.js'],
  ['combat',  'test-combat.js'],
  ['bots',    'test-bots.js'],
  ['soak',    'test-soak.js'],
  ['e2e',     'test-e2e.js']
];

let failed = 0;
const summary = [];

for (const [name, file] of suites) {
  console.log('\n============================================================');
  console.log('  ' + name.toUpperCase());
  console.log('============================================================');
  try {
    const out = execFileSync('node', [file], { cwd: __dirname, encoding: 'utf8' });
    process.stdout.write(out);
    const m = out.match(/(\d+)\/(\d+) passed/);
    summary.push(name + ': ' + (m ? m[0] : 'ok'));
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    failed++;
    const m = e.stdout && e.stdout.match(/(\d+)\/(\d+) passed/);
    summary.push(name + ': ' + (m ? m[0] + ' FAILED' : 'ERROR'));
  }
}

console.log('\n============================================================');
console.log('  SUMMARY');
console.log('============================================================');
summary.forEach(s => console.log('  ' + s));
console.log('');
if (failed) { console.log(failed + ' suite(s) failed.'); process.exit(1); }
console.log('All suites passed.');
