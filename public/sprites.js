// sprites.js
// Turns the LPC layer atlases into things the game can draw:
//   - composited character sheets (body + armour + hair + cape + wounds),
//     used as textures on the billboards that represent other players
//   - a first-person weapon view, cropped from the "carry"/"attack" frames
//
// LPC frames are 64x64. Our atlases stack four animation blocks vertically:
//   carry (walk)  rows 0-3     9 frames wide
//   attack        rows 4-7     6 frames
//   shoot         rows 8-11   13 frames
//   hurt          row 12       6 frames (single row - south facing only)
// Within a block the four rows are facing: 0 north, 1 west, 2 south, 3 east.

(function (exports) {
  'use strict';

  const FRAME = 64;
  let manifest = null;
  const images = {};          // url -> HTMLImageElement (or null if failed)
  let loadingAll = null;

  function loadImage(url) {
    if (url in images) return Promise.resolve(images[url]);
    return new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () { images[url] = img; resolve(img); };
      img.onerror = function () { images[url] = null; resolve(null); };
      img.src = url;
    });
  }

  // Load the manifest and every sprite up front - it is only ~0.4 MB, and
  // doing it once avoids hitches the first time a weapon or player appears.
  function loadAll() {
    if (loadingAll) return loadingAll;
    loadingAll = fetch('/sprites/manifest.json')
      .then(function (r) { return r.json(); })
      .then(function (m) {
        manifest = m;
        const urls = [];
        for (const k in m.layers) if (m.layers[k].file) urls.push(m.layers[k].file);
        for (const wk in m.weapons) {
          for (const part in m.weapons[wk]) urls.push(m.weapons[wk][part].file);
        }
        return Promise.all(urls.map(loadImage));
      })
      .then(function () { return manifest; })
      .catch(function () { manifest = null; return null; });
    return loadingAll;
  }

  function ready() { return !!manifest; }

  // The row within a block for a given facing.
  const FACING = { north: 0, west: 1, south: 2, east: 3 };

  // Build a full character sheet for one look + team, composited once and
  // cached. Returns a canvas the size of one atlas (832x832) that can be used
  // as a sprite texture and sampled per frame.
  const sheetCache = {};
  function characterSheet(look, team, wounds) {
    const key = [look.body, look.torso, look.hair, team, wounds | 0].join('|');
    if (sheetCache[key]) return sheetCache[key];
    if (!manifest) return null;

    const cvs = document.createElement('canvas');
    cvs.width = FRAME * manifest.cols;
    cvs.height = FRAME * 13;
    const ctx = cvs.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // Draw order is by z: body, armour, hair, cape, then wounds on top.
    const order = [look.body, look.torso, look.hair,
                   team === 'a' ? 'cape_red' : 'cape_blue'];
    // Wounds: show as many overlays as the player has taken
    const woundLayers = ['wound_ribs', 'wound_brain', 'wound_eye'];
    for (let i = 0; i < (wounds | 0) && i < woundLayers.length; i++) order.push(woundLayers[i]);

    for (const name of order) {
      const layer = manifest.layers[name];
      if (!layer || !layer.file) continue;
      const img = images[layer.file];
      if (img) ctx.drawImage(img, 0, 0);
    }

    sheetCache[key] = cvs;
    return cvs;
  }

  // Return the source rectangle for a given block, facing and frame index.
  function frameRect(block, facing, frameIndex) {
    const b = manifest.blocks[block] || manifest.blocks.carry;
    const rows = b.rows;
    const facingRow = block === 'hurt' ? 0 : Math.min(rows - 1, FACING[facing]);
    const col = Math.max(0, Math.min(b.frames - 1, frameIndex));
    return { sx: col * FRAME, sy: (b.row + facingRow) * FRAME, sw: FRAME, sh: FRAME };
  }

  // Weapon view for first person: the LPC "north" frames show the character
  // from behind holding the weapon, which is exactly a viewmodel. We crop the
  // lower-right of that frame - the hand and weapon - and let the client
  // position and animate it.
  const viewCache = {};
  function weaponView(weaponId, block, frameIndex) {
    const key = weaponId + '|' + block + '|' + frameIndex;
    if (viewCache[key]) return viewCache[key];
    if (!manifest || !weaponId || !manifest.weapons[weaponId]) return null;

    const cvs = document.createElement('canvas');
    cvs.width = FRAME; cvs.height = FRAME;
    const ctx = cvs.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const rect = frameRect(block, 'north', frameIndex);
    // background piece (behind arm), then the weapon foreground
    for (const part of ['bg', 'fg']) {
      const info = manifest.weapons[weaponId][part];
      if (!info) continue;
      const img = images[info.file];
      if (img) ctx.drawImage(img, rect.sx, rect.sy, FRAME, FRAME, 0, 0, FRAME, FRAME);
    }
    viewCache[key] = cvs;
    return cvs;
  }

  exports.FRAME = FRAME;
  exports.loadAll = loadAll;
  exports.ready = ready;
  exports.manifest = function () { return manifest; };
  exports.characterSheet = characterSheet;
  exports.frameRect = frameRect;
  exports.weaponView = weaponView;
  exports.image = function (url) { return images[url] || null; };

})(window.Sprites = {});
