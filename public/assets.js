// assets.js
// Loads the CC0 models and fits them into the game.
//
// Two rules here, both deliberate:
//
//   1. Models are decoration only. Collision, hit detection and every weapon
//      stat still come from the boxes in shared.js, which the server owns. A
//      model that loads differently - or fails to load - cannot change who
//      hits whom. It only changes what you see.
//
//   2. Everything falls back. If a file is missing, corrupt, or the network
//      drops, the procedural box models built in index.html stay on screen and
//      the game plays exactly as before. Nothing here is load-bearing.

(function (exports) {
  'use strict';

  // Artists model at wildly different scales and orientations. Rather than
  // hand-tuning six sets of magic numbers, each model is measured on load and
  // fitted: its longest axis becomes the barrel line, and it is scaled to the
  // length given here. `flip` turns a gun around if it ends up pointing at you.
  const MANIFEST = {
    rifle:   { url: '/models/weapon_rifle.glb',   length: 0.95, flip: false, grip: 0.30 },
    smg:     { url: '/models/weapon_smg.glb',     length: 0.72, flip: false, grip: 0.26 },
    dmr:     { url: '/models/weapon_dmr.glb',     length: 1.20, flip: false, grip: 0.34 },
    shotgun: { url: '/models/weapon_shotgun.glb', length: 1.00, flip: false, grip: 0.30 },
    pistol:  { url: '/models/weapon_pistol.glb',  length: 0.34, flip: false, grip: 0.10 },
    barrel:  { url: '/models/prop_barrel.glb',    prop: true }
  };

  const cache = {};        // name -> Promise<THREE.Object3D|null>
  let loader = null;
  let available = true;    // set false if GLTFLoader is not present

  function getLoader() {
    if (loader) return loader;
    if (typeof THREE === 'undefined' || !THREE.GLTFLoader) { available = false; return null; }
    loader = new THREE.GLTFLoader();
    return loader;
  }

  // Load a model, once. Resolves to null on any failure - callers keep their
  // procedural fallback in that case.
  function load(name) {
    if (cache[name]) return cache[name];
    const entry = MANIFEST[name];
    if (!entry) return Promise.resolve(null);

    cache[name] = new Promise(function (resolve) {
      const l = getLoader();
      if (!l) { resolve(null); return; }
      let settled = false;
      const done = function (v) { if (!settled) { settled = true; resolve(v); } };

      // Never let a hanging request stall the game
      setTimeout(function () { done(null); }, 12000);

      try {
        l.load(entry.url,
          function (gltf) { done(gltf.scene || null); },
          undefined,
          function () { done(null); });
      } catch (e) { done(null); }
    });
    return cache[name];
  }

  // Measure an object and return its bounding box size and centre.
  function measure(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3(), centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    return { size: size, centre: centre, box: box };
  }

  // Rotate so the model's longest axis runs along -Z (the way the camera
  // looks), scale it to `length` metres, and sit the grip at the origin.
  function fitWeapon(raw, entry) {
    const group = new THREE.Group();
    const inner = new THREE.Group();
    group.add(inner);
    inner.add(raw);

    let m = measure(raw);
    const axes = [m.size.x, m.size.y, m.size.z];
    const longest = axes.indexOf(Math.max.apply(null, axes));

    // Bring the long axis round to Z
    if (longest === 0) raw.rotation.y = Math.PI / 2;
    else if (longest === 1) raw.rotation.x = Math.PI / 2;
    raw.updateMatrixWorld(true);

    m = measure(raw);
    const scale = entry.length / Math.max(m.size.z, 0.0001);
    inner.scale.setScalar(scale);
    inner.updateMatrixWorld(true);

    // Recentre, then push it back so the grip - not the middle - is at origin
    const after = measure(inner);
    inner.position.sub(after.centre);
    inner.position.z += entry.grip;
    if (entry.flip) group.rotation.y = Math.PI;

    group.userData.length = entry.length;
    group.userData.muzzle = new THREE.Vector3(0, 0, -(entry.length - entry.grip));
    return group;
  }

  // Shared setup for anything we drop into the world
  function prepare(obj, opts) {
    opts = opts || {};
    obj.traverse(function (o) {
      if (!o.isMesh) return;
      o.castShadow = opts.shadows !== false;
      o.receiveShadow = opts.shadows !== false;
      if (o.material) {
        // These are unlit PS1-style textures; keep them matte so they sit
        // alongside the rest of the scene instead of looking wet.
        o.material.roughness = 0.85;
        o.material.metalness = 0.0;
        if (o.material.map) o.material.map.anisotropy = 4;
      }
    });
    return obj;
  }

  // A weapon for the player's hands. Resolves to null if it could not load.
  function weaponModel(weaponId) {
    const entry = MANIFEST[weaponId];
    if (!entry) return Promise.resolve(null);
    return load(weaponId).then(function (raw) {
      if (!raw) return null;
      try {
        const fitted = fitWeapon(raw.clone(true), entry);
        prepare(fitted, { shadows: false });
        fitted.traverse(function (o) { if (o.isMesh) o.renderOrder = 3; });
        return fitted;
      } catch (e) { return null; }
    });
  }

  // A prop scaled to fill a map box exactly, so the model matches its collider.
  function propModel(name, box) {
    return load(name).then(function (raw) {
      if (!raw) return null;
      try {
        const obj = raw.clone(true);
        const wrap = new THREE.Group();
        wrap.add(obj);
        const m = measure(obj);
        obj.position.sub(m.centre);
        const s = Math.min(box.w / Math.max(m.size.x, 1e-4),
                           box.h / Math.max(m.size.y, 1e-4),
                           box.d / Math.max(m.size.z, 1e-4));
        wrap.scale.setScalar(s);
        // Sit it on the floor of its box rather than centred in it
        wrap.position.set(box.x, box.y + (m.size.y * s) / 2, box.z);
        prepare(wrap);
        return wrap;
      } catch (e) { return null; }
    });
  }

  exports.MANIFEST = MANIFEST;
  exports.load = load;
  exports.weaponModel = weaponModel;
  exports.propModel = propModel;
  exports.measure = measure;
  exports.isAvailable = function () { getLoader(); return available; };

})(window.Assets = {});
