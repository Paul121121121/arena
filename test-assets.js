// Asset checks.
//
// A browser is what actually renders these, and there isn't one here - so
// these tests verify everything that can be verified without one: that the
// files exist, that they are valid glTF with their textures inside, that they
// are small enough to ship, and that the fitting maths turns each model into
// something the right size and pointing the right way.
const fs = require('fs');
const path = require('path');

const R = [];
const check = (n, ok, note) => {
  R.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (note ? '  [' + note + ']' : ''));
};

const MODELS = path.join(__dirname, 'public', 'models');
const VENDOR = path.join(__dirname, 'public', 'vendor');

// Mirrors the manifest in public/assets.js
const MANIFEST = {
  rifle:   { file: 'weapon_rifle.glb',   length: 0.95, grip: 0.30 },
  smg:     { file: 'weapon_smg.glb',     length: 0.72, grip: 0.26 },
  dmr:     { file: 'weapon_dmr.glb',     length: 1.20, grip: 0.34 },
  shotgun: { file: 'weapon_shotgun.glb', length: 1.00, grip: 0.30 },
  pistol:  { file: 'weapon_pistol.glb',  length: 0.34, grip: 0.10 },
  barrel:  { file: 'prop_barrel.glb',    prop: true }
};

// --- a small glTF reader, enough to inspect what we built -------------------

function readGLB(file) {
  const buf = fs.readFileSync(file);
  if (buf.slice(0, 4).toString() !== 'glTF') throw new Error('not a GLB');
  const version = buf.readUInt32LE(4);
  const declared = buf.readUInt32LE(8);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  return { json, version, declared, actual: buf.length };
}

// Bounding box of everything the scene actually draws
function sceneBounds(g) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let tris = 0, meshes = 0;
  const scene = (g.scenes || [{ nodes: [] }])[g.scene || 0];

  const visit = (i) => {
    const n = g.nodes[i];
    if (n.mesh !== undefined) {
      meshes++;
      for (const p of g.meshes[n.mesh].primitives) {
        const a = g.accessors[p.attributes.POSITION];
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], a.min[k]);
          hi[k] = Math.max(hi[k], a.max[k]);
        }
        if (p.indices !== undefined) tris += g.accessors[p.indices].count / 3;
      }
    }
    (n.children || []).forEach(visit);
  };
  (scene.nodes || []).forEach(visit);

  return { size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], tris, meshes };
}

// The same fit assets.js does: longest axis becomes the barrel line, then
// scale so that axis is `length` metres.
function fit(size, targetLength) {
  const longest = size.indexOf(Math.max(...size));
  let along = size.slice();
  if (longest === 0) along = [size[2], size[1], size[0]];       // rotate Y
  else if (longest === 1) along = [size[0], size[2], size[1]];  // rotate X
  const scale = targetLength / along[2];
  return { scaled: along.map(v => v * scale), scale, longest: 'XYZ'[longest] };
}

// --- checks -----------------------------------------------------------------

console.log('--- files ---');

check('the models folder exists', fs.existsSync(MODELS));

let totalKB = 0;
for (const [name, entry] of Object.entries(MANIFEST)) {
  const p = path.join(MODELS, entry.file);
  const exists = fs.existsSync(p);
  check(`${name}: ${entry.file} is present`, exists);
  if (exists) totalKB += fs.statSync(p).size / 1024;
}
check(`the whole set is small enough to ship (${Math.round(totalKB)} KB)`, totalKB < 3000,
  'a free host and a phone connection both have to cope with this');

console.log('\n--- three.js is vendored, not fetched from a CDN ---');

// Offline mode is not really offline if it needs a CDN to start.
const three = path.join(VENDOR, 'three.min.js');
const gltf = path.join(VENDOR, 'GLTFLoader.js');
check('three.min.js is bundled', fs.existsSync(three));
check('GLTFLoader.js is bundled', fs.existsSync(gltf));
if (fs.existsSync(gltf)) {
  const src = fs.readFileSync(gltf, 'utf8');
  check('the loader registers itself on THREE', src.includes('THREE.GLTFLoader'));
}
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
check('the page loads no scripts from a CDN', !/<script src="https?:\/\//.test(html),
  'otherwise offline mode needs the internet to start');
check('the page loads the local three.js and loader',
  html.includes('/vendor/three.min.js') && html.includes('/vendor/GLTFLoader.js'));

console.log('\n--- the model files themselves ---');

for (const [name, entry] of Object.entries(MANIFEST)) {
  const p = path.join(MODELS, entry.file);
  if (!fs.existsSync(p)) continue;

  let glb;
  try { glb = readGLB(p); }
  catch (e) { check(`${name}: parses as a GLB`, false, e.message); continue; }

  const g = glb.json;
  check(`${name}: valid glTF 2.0 with a matching header`,
    glb.version === 2 && glb.declared === glb.actual);

  const imgs = g.images || [];
  check(`${name}: texture is inside the file`,
    imgs.length > 0 && imgs.every(i => i.bufferView !== undefined && i.uri === undefined),
    imgs.length ? '' : 'no texture at all');

  const b = sceneBounds(g);
  check(`${name}: draws something (${b.meshes} mesh, ${Math.round(b.tris)} tris)`,
    b.meshes > 0 && b.tris > 0);
  check(`${name}: light enough to render (${Math.round(b.tris)} tris)`, b.tris < 6000);
  check(`${name}: has real size in all three axes`,
    b.size.every(v => v > 0 && isFinite(v)));

  if (!entry.prop) {
    const f = fit(b.size, entry.length);
    check(`${name}: fits to ${entry.length}m along the barrel ` +
      `(from ${b.size.map(v => v.toFixed(1)).join('x')}, longest ${f.longest})`,
      Math.abs(f.scaled[2] - entry.length) < 0.001);

    // A gun that ends up as tall as it is long has been fitted wrong
    const chunk = Math.max(f.scaled[0], f.scaled[1]) / f.scaled[2];
    check(`${name}: keeps gun-like proportions (${chunk.toFixed(2)} thick vs long)`, chunk < 0.75);

    // The grip has to sit inside the model, not off the end of it
    check(`${name}: grip offset is inside the weapon`,
      entry.grip > 0 && entry.grip < entry.length * 0.6);
  }
}

console.log('\n--- the game still works without any of this ---');

const assets = fs.readFileSync(path.join(__dirname, 'public', 'assets.js'), 'utf8');
check('a failed load resolves to null rather than throwing',
  assets.includes('resolve(null)') && assets.includes('catch'));
check('there is a timeout so a hung request cannot stall the game',
  assets.includes('setTimeout'));
check('the client keeps the procedural model until a real one arrives',
  html.includes('if (!model) return;'));
check('props only hide their box after the model loads',
  html.includes('m.visible = false;'));

// The important one: models must not be able to change the rules.
const shared = fs.readFileSync(path.join(__dirname, 'public', 'shared.js'), 'utf8');
const game = fs.readFileSync(path.join(__dirname, 'public', 'game.js'), 'utf8');
check('the physics never mentions models', !/Assets|GLTF|\.glb/.test(shared));
check('the simulation never mentions models', !/Assets|GLTF|\.glb/.test(game));

console.log('');
const pass = R.filter(Boolean).length;
console.log(`${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
