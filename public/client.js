// client.js
// The browser side. Renders the castle in first person with a pixel look,
// draws other players as LPC sprite billboards, holds the current weapon in
// view Mordhau-style, and runs the netcode (prediction, reconciliation,
// interpolation) against either the real server or the offline host.

(function () {
'use strict';

var CONFIG = null, MAP = null, WEAPONS = null, LOOK_OPTIONS = null;
var myId = null, myTeam = 'a', socket = null, isOffline = false;
var $ = function (id) { return document.getElementById(id); };

// Chosen in the menu
var look = { body: 'body_light', torso: 'torso_chain', hair: 'hair_messy' };
var chosenBots = 5, chosenSkill = 'regular';

// ===========================================================================
// Renderer - low internal resolution, scaled up, for the pixel look
// ===========================================================================

var PIXEL_SCALE = 3;                 // one game pixel = 3 screen pixels
var canvas = $('view');
var scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb0c4);
scene.fog = new THREE.Fog(0x9fb0c4, 40, 130);

var camera = new THREE.PerspectiveCamera(74, 1, 0.05, 400);
camera.rotation.order = 'YXZ';
scene.add(camera);

var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = false;   // keep it cheap and flat, like the era it evokes

function resize() {
  var w = Math.floor(innerWidth / PIXEL_SCALE);
  var h = Math.floor(innerHeight / PIXEL_SCALE);
  renderer.setSize(w, h, false);
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// Flat medieval lighting - a warm key from the side, cool ambient fill
scene.add(new THREE.HemisphereLight(0xcdd6e0, 0x3a3428, 0.95));
var sun = new THREE.DirectionalLight(0xffe4bd, 0.75);
sun.position.set(30, 50, 18);
scene.add(sun);

// ===========================================================================
// Level
// ===========================================================================

var SURF = {
  stone:  0x8a8478, cliff: 0x5a5348, wood: 0x6b4a2c, crate: 0x8a6a42,
  barrel: 0x7a4a3a, ruin: 0x746c5c, fence: 0x5c4a34
};

function texFor(hex, kind) {
  // A tiny procedural pixel texture so surfaces are not flat colour
  var c = document.createElement('canvas'); c.width = c.height = 16;
  var x = c.getContext('2d');
  var base = new THREE.Color(hex);
  for (var i = 0; i < 16; i++) for (var j = 0; j < 16; j++) {
    var n = (Math.random() - 0.5) * 0.16;
    var mortar = (kind === 'stone' && (i % 8 === 0 || j % 4 === 0)) ? -0.22 : 0;
    var r = Math.max(0, Math.min(1, base.r + n + mortar));
    var g = Math.max(0, Math.min(1, base.g + n + mortar));
    var b = Math.max(0, Math.min(1, base.b + n + mortar));
    x.fillStyle = 'rgb(' + (r*255|0) + ',' + (g*255|0) + ',' + (b*255|0) + ')';
    x.fillRect(i, j, 1, 1);
  }
  var tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function buildLevel() {
  var ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP.width + 40, MAP.depth + 40),
    new THREE.MeshLambertMaterial({ map: texFor(0x5c6b3a, 'grass') })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.material.map.repeat.set((MAP.width + 40) / 3, (MAP.depth + 40) / 3);
  scene.add(ground);

  var mats = {};
  Object.keys(SURF).forEach(function (k) {
    mats[k] = new THREE.MeshLambertMaterial({ map: texFor(SURF[k], k) });
  });

  MAP.boxes.forEach(function (b) {
    var mat = mats[b.k] || mats.stone;
    var geo = new THREE.BoxGeometry(b.w, b.h, b.d);
    var m = new THREE.Mesh(geo, mat);
    m.position.set(b.x, b.y + b.h / 2, b.z);
    // Tile the texture to the box size so bricks stay a constant scale
    if (mat.map) {
      // clone so each size gets its own repeat
      var mm = mat.clone(); mm.map = mat.map.clone(); mm.map.needsUpdate = true;
      mm.map.magFilter = THREE.NearestFilter; mm.map.minFilter = THREE.NearestFilter;
      mm.map.wrapS = mm.map.wrapT = THREE.RepeatWrapping;
      mm.map.repeat.set(Math.max(1, b.w / 2), Math.max(1, b.h / 2));
      m.material = mm;
    }
    scene.add(m);
  });
}

// ===========================================================================
// Sprite billboards for other players
// ===========================================================================

var billboards = {};        // id -> { sprite, texture, canvas, ctx, anim }

function makeBillboard(info) {
  var cvs = document.createElement('canvas');
  cvs.width = 64; cvs.height = 64;
  var ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  var tex = new THREE.CanvasTexture(cvs);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
  var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.35 });
  var sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.0, 2.0, 1);      // roughly player height
  scene.add(sprite);

  // Team ring under the feet, so friend and foe read instantly
  var ringGeo = new THREE.RingGeometry(0.4, 0.55, 16);
  var ringMat = new THREE.MeshBasicMaterial({
    color: info.team === 'a' ? 0xb03a2e : 0x2e6fb0, transparent: true, opacity: 0.7,
    side: THREE.DoubleSide, depthWrite: false
  });
  var ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);

  return {
    sprite: sprite, ring: ring, texture: tex, canvas: cvs, ctx: ctx,
    anim: { block: 'carry', frame: 0, t: 0 }, lastX: info.x || 0, lastZ: info.z || 0,
    look: info.look, team: info.team, weapon: 0, wounds: 0
  };
}

// Which way is this sprite facing relative to the camera? LPC has 4 facings.
function facingToCamera(bbYaw) {
  // Angle from the sprite to the camera, minus the sprite's own yaw
  var toCam = Math.atan2(camera.position.x - lastBillboardPos.x,
                         -(camera.position.z - lastBillboardPos.z));
  var rel = toCam - bbYaw;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  // rel ~0 means they face us (south sprite), PI means back (north), etc.
  var a = Math.abs(rel);
  if (a < Math.PI / 4) return 'south';
  if (a > 3 * Math.PI / 4) return 'north';
  return rel > 0 ? 'east' : 'west';
}
var lastBillboardPos = { x: 0, z: 0 };

function drawBillboard(bb, facing) {
  if (!Sprites.ready()) return;
  var sheet = Sprites.characterSheet(bb.look, bb.team, bb.wounds);
  if (!sheet) return;
  var rect = Sprites.frameRect(bb.anim.block, facing, bb.anim.frame);
  bb.ctx.clearRect(0, 0, 64, 64);
  // body sheet
  bb.ctx.drawImage(sheet, rect.sx, rect.sy, 64, 64, 0, 0, 64, 64);
  // weapon over it (foreground/background both, cropped to same frame)
  var wid = WEAPONS[bb.weapon] && WEAPONS[bb.weapon].sprite;
  if (wid) {
    var man = Sprites.manifest();
    if (man && man.weapons[wid]) {
      ['bg', 'fg'].forEach(function (part) {
        var info = man.weapons[wid][part];
        if (!info) return;
        var img = Sprites.image(info.file);
        if (img) bb.ctx.drawImage(img, rect.sx, rect.sy, 64, 64, 0, 0, 64, 64);
      });
    }
  }
  bb.texture.needsUpdate = true;
}

// ===========================================================================
// Flags, pedestals, medkits, arrows - simple 3D markers
// ===========================================================================

var flagMeshes = {}, pedestalMeshes = [], medkitMeshes = [], arrowMeshes = {};

function makeFlag(team) {
  var g = new THREE.Group();
  var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6),
    new THREE.MeshLambertMaterial({ color: 0x6b4a2c }));
  pole.position.y = 1.3; g.add(pole);
  var cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6),
    new THREE.MeshBasicMaterial({ color: team === 'a' ? 0xb03a2e : 0x2e6fb0, side: THREE.DoubleSide }));
  cloth.position.set(0.45, 2.1, 0); g.add(cloth);
  g.userData.cloth = cloth;
  scene.add(g);
  return g;
}

function makePedestal(weaponId) {
  var g = new THREE.Group();
  var base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.9, 8),
    new THREE.MeshLambertMaterial({ color: 0x9a9488 }));
  base.position.y = 0.45; g.add(base);
  // Floating sprite of the weapon on top
  var cvs = document.createElement('canvas'); cvs.width = cvs.height = 64;
  var tex = new THREE.CanvasTexture(cvs);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
  var spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.3 }));
  spr.scale.set(1.3, 1.3, 1); spr.position.y = 1.5; g.add(spr);
  g.userData.sprite = spr; g.userData.canvas = cvs; g.userData.tex = tex; g.userData.weaponId = weaponId;
  g.userData.bob = Math.random() * 6.28;
  scene.add(g);
  return g;
}

function drawPedestalIcon(g) {
  var wid = g.userData.weaponId;
  var man = Sprites.ready() ? Sprites.manifest() : null;
  if (!man) return;
  var ctx = g.userData.canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 64, 64);
  var w = Shared.WEAPON_BY_ID[wid];
  if (w && w.sprite && man.weapons[w.sprite]) {
    ['bg', 'fg'].forEach(function (part) {
      var info = man.weapons[w.sprite][part];
      if (!info) return;
      var img = Sprites.image(info.file);
      // south-facing carry frame 0
      if (img) ctx.drawImage(img, 0, 2 * 64, 64, 64, 0, 0, 64, 64);
    });
  }
  g.userData.tex.needsUpdate = true;
}

function makeMedkit() {
  var g = new THREE.Group();
  var box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5),
    new THREE.MeshLambertMaterial({ color: 0xf0ede4 }));
  box.position.y = 0.3; g.add(box);
  var cross = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3),
    new THREE.MeshBasicMaterial({ color: 0xc0392b }));
  cross.position.set(0, 0.3, 0.26); g.add(cross);
  g.userData.bob = Math.random() * 6.28;
  scene.add(g);
  return g;
}

function makeArrow() {
  var g = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 5),
    new THREE.MeshLambertMaterial({ color: 0x4a3520 }));
  g.rotation.x = Math.PI / 2;
  scene.add(g);
  return g;
}

// ===========================================================================
// First-person viewmodel - the LPC weapon held in the corner of the screen
// ===========================================================================

var vmCanvas = document.createElement('canvas');
vmCanvas.width = 128; vmCanvas.height = 128;
var vmTex = new THREE.CanvasTexture(vmCanvas);
vmTex.magFilter = THREE.NearestFilter; vmTex.minFilter = THREE.NearestFilter;
var vmMat = new THREE.SpriteMaterial({ map: vmTex, transparent: true, depthTest: false, alphaTest: 0.2 });
var viewmodel = new THREE.Sprite(vmMat);
viewmodel.renderOrder = 999;
// Parent to the camera so it stays glued to the view
camera.add(viewmodel);
viewmodel.position.set(0.34, -0.42, -1);
viewmodel.scale.set(1.1, 1.1, 1);

var vmState = { block: 'carry', frame: 0, t: 0, swinging: false, swingT: 0 };

function drawViewmodel(weaponIdx) {
  var ctx = vmCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 128, 128);
  if (!Sprites.ready()) return;

  var w = WEAPONS[weaponIdx];
  // Draw the player's own arm+torso from behind (north facing) so a hand
  // holds the weapon, then the weapon over it.
  var sheet = Sprites.characterSheet(look, myTeam, 0);
  var block = vmState.swinging ? (w.kind === 'ranged' ? 'shoot' : 'attack') : 'carry';
  var man = Sprites.manifest();
  var frames = man.blocks[block].frames;
  var frame = vmState.swinging ? Math.min(frames - 1, Math.floor(vmState.swingT * frames)) : 0;
  var rect = Sprites.frameRect(block, 'north', frame);

  // Only the lower ~60% of the sprite (arms + weapon), scaled up big
  var srcY = rect.sy + 26, srcH = 38;
  if (sheet) ctx.drawImage(sheet, rect.sx, srcY, 64, srcH, 0, 20, 128, 76);
  if (w.sprite && man.weapons[w.sprite]) {
    ['bg', 'fg'].forEach(function (part) {
      var info = man.weapons[w.sprite][part];
      if (!info) return;
      var img = Sprites.image(info.file);
      if (img) ctx.drawImage(img, rect.sx, srcY, 64, srcH, 0, 20, 128, 76);
    });
  }
  vmTex.needsUpdate = true;
}

// ===========================================================================
// Input
// ===========================================================================

var keys = {};
var yaw = 0, pitch = 0, locked = false, mouseL = false, mouseR = false;
var jumpQueued = false;
var SENS = 0.0022;

addEventListener('keydown', function (e) {
  if (e.code === 'Tab') { e.preventDefault(); showBoard(true); }
  if (e.code === 'Space' && !keys.Space) jumpQueued = true;   // edge-triggered
  keys[e.code] = true;
});
addEventListener('keyup', function (e) {
  if (e.code === 'Tab') { e.preventDefault(); showBoard(false); }
  keys[e.code] = false;
});
addEventListener('blur', function () { keys = {}; mouseL = mouseR = false; });
addEventListener('contextmenu', function (e) { e.preventDefault(); });

canvas.addEventListener('mousedown', function () { if (!locked && myId) canvas.requestPointerLock(); });
document.addEventListener('pointerlockchange', function () {
  locked = document.pointerLockElement === canvas;
  $('hint').style.display = (myId && !locked) ? 'block' : 'none';
});
document.addEventListener('mousemove', function (e) {
  if (!locked) return;
  yaw -= e.movementX * SENS;
  pitch -= e.movementY * SENS;
  pitch = Math.max(-1.5, Math.min(1.5, pitch));
});
document.addEventListener('mousedown', function (e) {
  if (e.button === 0) mouseL = true;
  if (e.button === 2) mouseR = true;
});
document.addEventListener('mouseup', function (e) {
  if (e.button === 0) mouseL = false;
  if (e.button === 2) mouseR = false;
});

// ===========================================================================
// Netcode
// ===========================================================================

var me = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, crouch: false, jumps: 0 };
var pending = [], seq = 0, alive = true;
var myWeapon = 0, myHealth = 100, myStamina = 100, carryingFlag = null;
var others = {}, roster = {}, offset = 0;
var scores = { a: 0, b: 0 }, matchEndsAt = 0, matchPhase = 'live';
var pedestalReady = [], liveKits = [], flagData = null;
var lastUse = 0;

function weapon() { return WEAPONS ? WEAPONS[myWeapon] : null; }

function connect(name, offlineOpts) {
  if (offlineOpts) { isOffline = true; socket = Offline.createLocalSocket(offlineOpts); }
  else {
    isOffline = false;
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    socket = new WebSocket(proto + location.host);
  }

  socket.onopen = function () { socket.send(JSON.stringify({ type: 'join', name: name, look: look })); };
  socket.onerror = function () { status('Could not reach the server. Try practice vs bots.'); resetButtons(); };
  socket.onclose = function () {
    if (isOffline) return;
    status('Connection lost. Refresh to rejoin.'); $('menu').style.display = 'flex';
  };
  socket.onmessage = function (ev) { handle(JSON.parse(ev.data)); };
}

function handle(m) {
  switch (m.type) {
    case 'welcome':
      CONFIG = m.config; MAP = m.map; WEAPONS = Shared.WEAPONS; LOOK_OPTIONS = m.lookOptions;
      myId = m.id; myTeam = m.team;
      me.x = m.you.x; me.y = m.you.y; me.z = m.you.z; yaw = m.you.yaw;
      scores = m.match.scores; matchEndsAt = m.match.endsAt; matchPhase = m.match.phase;
      m.players.forEach(function (p) { roster[p.id] = p; });
      buildLevel();
      buildFlagsAndPickups();
      $('goalN').textContent = CONFIG.CAPTURES_TO_WIN;
      $('menu').style.display = 'none';
      $('hud').style.display = 'block';
      $('modeTag').textContent = isOffline ? 'PRACTICE - ' + chosenSkill.toUpperCase() + ' BOTS' : '';
      drawViewmodel(0);
      canvas.requestPointerLock();
      $('hint').style.display = 'block';
      if (window.Audio2) { Audio2.unlock(); Audio2.battleMusic(); }
      banner((myTeam === 'a' ? 'CRIMSON' : 'AZURE'),
             'Take the enemy flag. First to ' + CONFIG.CAPTURES_TO_WIN + ' wins.', 3000);
      break;

    case 'roster':
      roster = {}; m.players.forEach(function (p) { roster[p.id] = p; });
      break;
    case 'joined': roster[m.id] = { id: m.id, name: m.name, team: m.team, k:0,d:0,caps:0,ret:0 }; break;
    case 'left':
      delete roster[m.id];
      if (billboards[m.id]) { scene.remove(billboards[m.id].sprite); scene.remove(billboards[m.id].ring); delete billboards[m.id]; }
      delete others[m.id];
      break;

    case 'snapshot': onSnapshot(m); break;

    case 'windup':
      if (m.id !== myId && billboards[m.id]) billboards[m.id].anim = { block: 'attack', frame: 0, t: 0 };
      break;
    case 'swing':
      if (m.id === myId) { vmState.swinging = true; vmState.swingT = 0; if (window.Audio2) Audio2.playVaried('swing', { volume: 0.5 }); }
      else if (billboards[m.id]) {
        billboards[m.id].anim = { block: 'attack', frame: 0, t: 0 };
        var sp = billboards[m.id].sprite.position;
        if (window.Audio2) Audio2.playVaried('swing', { at: { x: sp.x, y: sp.y, z: sp.z }, volume: 0.5 });
      }
      break;
    case 'loose':
      var lw = WEAPONS[m.w] ? WEAPONS[m.w].id : 'bow';
      var lsound = lw === 'crossbow' ? 'crossbow' : 'bow';
      if (m.id === myId) { vmState.swinging = true; vmState.swingT = 0; if (window.Audio2) Audio2.playVaried(lsound, { volume: 0.55 }); }
      else if (billboards[m.id] && window.Audio2) {
        var bp = billboards[m.id].sprite.position;
        Audio2.playVaried(lsound, { at: { x: bp.x, y: bp.y, z: bp.z }, volume: 0.55 });
      }
      break;
    case 'impact': spawnImpact(m); if (window.Audio2 && m.kind !== 'expire') Audio2.playVaried(m.kind === 'player' ? 'hit' : 'footstep', { at: { x: m.x, y: m.y, z: m.z }, volume: m.kind === 'player' ? 0.5 : 0.25 }); break;

    case 'hitmarker': hitmark(m.head, m.lethal); if (window.Audio2) Audio2.play('hit', { volume: 0.55, rate: m.head ? 1.2 : 1 }); break;
    case 'hurt': myHealth = m.health; setVitals(); hurtFlash(m.fx, m.fz); if (window.Audio2) Audio2.play('hurt', { volume: 0.6 }); break;
    case 'blocked': myStamina = m.stamina; setVitals(); if (window.Audio2) Audio2.playVaried('block', { volume: 0.6 }); break;
    case 'blockedby': if (window.Audio2) Audio2.playVaried('block', { volume: 0.5 }); break;
    case 'healed': myHealth = m.health; setVitals(); flashHeal(); if (window.Audio2) Audio2.play('heal', { volume: 0.6 }); break;
    case 'picked':
      myWeapon = Shared.WEAPON_BY_ID[m.weapon].index;
      setWeaponUI(); drawViewmodel(myWeapon);
      if (window.Audio2) Audio2.play('pickup', { volume: 0.6 });
      break;
    case 'exhausted': case 'dryfire': break;

    case 'kill': onKill(m); if (window.Audio2 && (m.victimId === myId || m.killerId === myId)) Audio2.play('death', { volume: m.victimId === myId ? 0.7 : 0.4 }); break;
    case 'respawn':
      me.x = m.x; me.y = m.y; me.z = m.z; me.vx = me.vy = me.vz = 0; me.jumps = 0;
      yaw = m.yaw; pitch = 0; myTeam = m.team || myTeam;
      pending.length = 0; alive = true; myWeapon = 0; carryingFlag = null;
      myHealth = CONFIG.MAX_HEALTH; myStamina = CONFIG.MAX_STAMINA;
      setVitals(); setWeaponUI(); drawViewmodel(0);
      $('dead').style.display = 'none';
      break;

    case 'flag': onFlag(m); if (window.Audio2 && (m.event === 'taken' || m.event === 'returned')) Audio2.play('flagtake', { volume: 0.5 }); break;
    case 'capture':
      scores = m.scores; setScores();
      logEvent((m.team === myTeam ? 'Your team' : 'Enemy') + ' captured a flag!');
      if (window.Audio2) Audio2.play('capture', { volume: 0.6, rate: m.team === myTeam ? 1 : 0.8 });
      break;
    case 'pedestal': pedestalReady[m.idx] = m.ready; break;
    case 'medkit': /* handled via snapshot kits */ break;

    case 'match-start':
      scores = m.scores; matchEndsAt = m.endsAt; matchPhase = 'live';
      if (m.teams && m.teams[myId]) myTeam = m.teams[myId];
      setScores();
      for (var k in billboards) { scene.remove(billboards[k].sprite); scene.remove(billboards[k].ring); }
      billboards = {};
      if (window.Audio2) Audio2.battleMusic();
      banner('MATCH ' + m.number, 'Teams reshuffled - you are ' + (myTeam === 'a' ? 'Crimson' : 'Azure'), 3200);
      break;
    case 'match-end':
      matchPhase = 'intermission';
      var w = m.winner;
      if (window.Audio2) { if (w === myTeam) Audio2.play('capture', { volume: 0.7 }); else if (w !== null) Audio2.play('lose', { volume: 0.6 }); }
      banner(w === null ? 'STALEMATE' : (w === myTeam ? 'VICTORY' : 'DEFEAT'),
             'Crimson ' + m.scores.a + '  -  ' + m.scores.b + ' Azure  |  next match in ' +
             Math.round(m.nextIn/1000) + 's', m.nextIn - 500);
      break;

    case 'ping-request': socket.send(JSON.stringify({ type: 'pong', t: m.t })); break;
    case 'ping': $('ping').textContent = m.value; break;
  }
}

function onSnapshot(m) {
  offset = m.t - Date.now();
  flagData = m.flags;
  liveKits = m.kits || [];
  if (m.peds) pedestalReady = m.peds;

  for (var i = 0; i < m.players.length; i++) {
    var s = m.players[i];
    if (s.id === myId) {
      alive = s.al === 1;
      me.x = s.x; me.y = s.y; me.z = s.z;
      var keep = [];
      for (var j = 0; j < pending.length; j++) {
        if (pending[j].seq > s.seq) { Shared.stepPlayer(me, pending[j], pending[j].dt, weapon(), !!s.fl); keep.push(pending[j]); }
      }
      pending = keep;
      myHealth = s.h; myStamina = s.st; myWeapon = s.w; carryingFlag = s.fl;
      setVitals();
      if (WEAPONS[myWeapon] && $('wname').textContent !== WEAPONS[myWeapon].name) { setWeaponUI(); drawViewmodel(myWeapon); }
      $('carrying').style.display = s.fl ? 'block' : 'none';
      continue;
    }
    if (!others[s.id]) others[s.id] = { buffer: [] };
    var o = others[s.id];
    o.alive = s.al === 1; o.weapon = s.w; o.wounds = s.wd; o.speed = s.sp; o.attacking = s.atk;
    o.buffer.push({ t: m.t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, c: s.c });
    while (o.buffer.length > 26) o.buffer.shift();
  }

  // arrows in flight
  var seen = {};
  (m.arrows || []).forEach(function (a) {
    seen[a.id] = true;
    if (!arrowMeshes[a.id]) arrowMeshes[a.id] = makeArrow();
    var mesh = arrowMeshes[a.id];
    mesh.position.set(a.x, a.y, a.z);
    var v = new THREE.Vector3(a.vx, a.vy, a.vz);
    if (v.lengthSq() > 0.01) mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), v.normalize());
  });
  for (var id in arrowMeshes) if (!seen[id]) { scene.remove(arrowMeshes[id]); delete arrowMeshes[id]; }
}

function sendInput(dt) {
  if (!socket || socket.readyState !== 1 || !CONFIG) return;
  var crouch = !!(keys.ControlLeft || keys.ControlRight || keys.KeyC);
  var f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  var r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  var sprint = !!keys.ShiftLeft && f > 0.5 && !crouch;
  var w = weapon();
  var block = mouseR && w && w.kind === 'melee';
  var attack = mouseL && locked && !block;

  var now = performance.now();
  var use = false;
  if (keys.KeyE && now - lastUse > 250) { use = true; lastUse = now; }

  var input = {
    type: 'input', seq: ++seq, dt: dt,
    forward: f, right: r,
    jumpEdge: jumpQueued, crouch: crouch, sprint: sprint,
    attack: attack, block: block, use: use,
    yaw: yaw, pitch: pitch
  };
  if (jumpQueued && me.jumps < (CONFIG.MAX_JUMPS || 2) && window.Audio2) {
    Audio2.playVaried('jump', { volume: 0.4 });
  }
  jumpQueued = false;
  socket.send(JSON.stringify(input));

  Shared.stepPlayer(me, input, dt, w, !!carryingFlag);
  pending.push(input);
  if (pending.length > 240) pending.shift();
}

// ===========================================================================
// Flags / pickups setup and per-frame update
// ===========================================================================

function buildFlagsAndPickups() {
  flagMeshes.a = makeFlag('a'); flagMeshes.b = makeFlag('b');
  MAP.pedestals.forEach(function (p, i) {
    pedestalMeshes[i] = makePedestal(p.id);
    pedestalMeshes[i].position.set(p.x, 0, p.z);
    pedestalReady[i] = true;
  });
  for (var i = 0; i < 3; i++) { medkitMeshes[i] = makeMedkit(); medkitMeshes[i].visible = false; }
}

function updateWorldObjects(dt, nowMs) {
  if (flagData) {
    ['a','b'].forEach(function (key) {
      var f = flagData[key], mesh = flagMeshes[key];
      if (!mesh) return;
      mesh.visible = f.state !== 'carried';   // carried flags ride the player billboard
      mesh.position.set(f.x, f.y, f.z);
      mesh.userData.cloth.material.opacity = f.state === 'dropped' ? 0.6 : 1;
    });
  }
  pedestalMeshes.forEach(function (g, i) {
    var ready = pedestalReady[i] !== 0 && pedestalReady[i] !== false;
    g.userData.sprite.visible = ready;
    g.userData.bob += dt * 2;
    g.userData.sprite.position.y = 1.5 + Math.sin(g.userData.bob) * 0.08;
    if (ready && !g.userData.drawn) { drawPedestalIcon(g); g.userData.drawn = true; }
  });
  // medkits from snapshot
  liveKits.forEach(function (k, i) {
    var mesh = medkitMeshes[i];
    if (!mesh) return;
    if (k.r) { mesh.visible = true; mesh.position.set(k.x, 0, k.z);
      mesh.userData.bob += dt * 2; mesh.position.y = Math.sin(mesh.userData.bob) * 0.08; }
    else mesh.visible = false;
  });
}

// ===========================================================================
// Effects
// ===========================================================================

var impacts = [];
function spawnImpact(m) {
  if (m.kind === 'expire') return;
  var color = m.kind === 'player' ? 0x9c1a12 : 0xcabf9a;
  for (var i = 0; i < 5; i++) {
    var p = new THREE.Mesh(new THREE.BoxGeometry(0.06,0.06,0.06),
      new THREE.MeshBasicMaterial({ color: color }));
    p.position.set(m.x, m.y, m.z);
    scene.add(p);
    impacts.push({ mesh: p, life: 0.4, vel: new THREE.Vector3((Math.random()-.5)*3, Math.random()*2.5, (Math.random()-.5)*3) });
  }
}

// ===========================================================================
// HUD
// ===========================================================================

function setVitals() {
  $('hpfill').style.width = Math.max(0, myHealth) + '%';
  $('stfill').style.width = Math.max(0, myStamina) + '%';
  $('vitals').classList.toggle('low', myHealth <= 30);
}
function setWeaponUI() {
  var w = WEAPONS[myWeapon];
  $('wname').textContent = w.name;
  $('wkind').textContent = w.kind === 'ranged' ? 'ranged' : 'melee';
}
function setScores() { $('capA').textContent = scores.a; $('capB').textContent = scores.b; }

function hitmark(head, lethal) {
  var c = $('cross'); c.classList.add('hit');
  setTimeout(function () { c.classList.remove('hit'); }, lethal ? 240 : 110);
}
function hurtFlash(fx, fz) {
  $('vig').style.opacity = '1'; setTimeout(function () { $('vig').style.opacity = '0'; }, 120);
  if (fx === undefined) return;
  var ang = Math.atan2(fx - me.x, -(fz - me.z));
  var deg = (ang - yaw) * 180 / Math.PI;
  var el = document.createElement('div'); $('dmgdir').appendChild(el);
  el.style.transform = 'rotate(' + (deg + 180) + 'deg) translateY(-150px)';
  requestAnimationFrame(function () { el.style.opacity = '1'; });
  setTimeout(function () { el.style.opacity = '0'; }, 650);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1300);
}
function flashHeal() { $('vig').style.boxShadow = 'inset 0 0 120px rgba(40,150,60,.6)';
  $('vig').style.opacity = '1'; setTimeout(function(){ $('vig').style.opacity='0';
  setTimeout(function(){ $('vig').style.boxShadow='inset 0 0 180px rgba(140,20,15,.9)'; },350); }, 120); }

function onKill(m) {
  var wname = (Shared.WEAPON_BY_ID[m.weapon] || {}).name || '';
  feed('<span class="' + m.killerTeam + '">' + m.killer + '</span>' +
       '<span class="mid">' + wname + (m.head ? ' <span class="hs">&#9733;</span>' : '') + '</span>' +
       '<span class="' + m.victimTeam + '">' + m.victim + '</span>');
  if (roster[m.killerId]) roster[m.killerId].k++;
  if (roster[m.victimId]) roster[m.victimId].d++;
  if (m.victimId === myId) {
    alive = false;
    $('deadmsg').innerHTML = 'Slain by <b>' + m.killer + '</b>';
    $('dead').style.display = 'flex';
    var left = Math.ceil(CONFIG.RESPAWN_MS / 1000); $('deadcount').textContent = left;
    clearInterval(deadTimer);
    deadTimer = setInterval(function () { left--; $('deadcount').textContent = Math.max(0, left); }, 1000);
  }
}
var deadTimer = null;

function onFlag(m) {
  var teamName = m.team === 'a' ? 'Crimson' : 'Azure';
  if (m.event === 'taken') logEvent((m.team === myTeam ? 'Your' : 'Enemy') + ' flag taken by ' + m.by + '!');
  else if (m.event === 'dropped') logEvent(teamName + ' flag dropped');
  else if (m.event === 'returned') logEvent(teamName + ' flag returned');
}

function feed(html) {
  var f = $('feed'); var d = document.createElement('div'); d.innerHTML = html; f.appendChild(d);
  while (f.children.length > 6) f.removeChild(f.firstChild);
  setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 6500);
}
function logEvent(text) {
  var e = $('events'); var d = document.createElement('div'); d.textContent = text; e.appendChild(d);
  setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 3500);
}

var bannerTimer = null;
function banner(t, s, ms) {
  $('btitle').textContent = t; $('bsub').textContent = s || '';
  $('banner').style.display = 'block';
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(function () { $('banner').style.display = 'none'; }, ms || 2500);
}

function showBoard(on) {
  var b = $('board');
  if (!on) { b.style.display = 'none'; return; }
  if (!CONFIG) return;
  ['a','b'].forEach(function (t) {
    var rows = Object.keys(roster).map(function (id) { return roster[id]; })
      .filter(function (p) { return p.team === t; })
      .sort(function (x, y) { return (y.caps - x.caps) || (y.k - x.k); });
    $('rows' + t.toUpperCase()).innerHTML = rows.map(function (p) {
      return '<tr class="' + (p.id === myId ? 'me' : '') + '"><td>' + p.name + (p.bot ? ' &middot;' : '') +
        '</td><td>' + (p.caps||0) + '</td><td>' + (p.ret||0) + '</td><td>' + (p.k||0) + '</td><td>' + (p.d||0) + '</td></tr>';
    }).join('') || '<tr><td style="color:#5d5647">—</td><td></td><td></td><td></td><td></td></tr>';
  });
  $('boardSub').textContent = 'Crimson ' + scores.a + '  —  ' + scores.b + ' Azure';
  b.style.display = 'block';
}

function status(t) { $('status').textContent = t; }
function resetButtons() { $('goOnline').disabled = false; $('goOffline').disabled = false; }

// ===========================================================================
// Frame loop
// ===========================================================================

var last = performance.now(), accum = 0, STEP = 1/60;
var bobPhase = 0;
var stepClock = 0;

// Footsteps: play on a cadence while moving on the ground, faster when sprinting.
function footstepAudio(dt, speed) {
  if (!window.Audio2 || !alive) return;
  var onGround = me.y <= Shared.groundHeight(me.x, me.z, me.y) + 0.06;
  if (!onGround || speed < 1.5) { stepClock = 0; return; }
  stepClock -= dt;
  if (stepClock <= 0) {
    Audio2.playVaried('footstep', { volume: 0.35 });
    stepClock = speed > (CONFIG.BASE_SPEED || 6) * 1.1 ? 0.30 : 0.42;
  }
}

function frame() {
  requestAnimationFrame(frame);
  var nowP = performance.now();
  var dt = Math.min((nowP - last) / 1000, 0.1);
  last = nowP;

  if (myId && CONFIG) {
    accum += dt;
    var guard = 0;
    while (accum >= STEP && guard++ < 5) { sendInput(STEP); accum -= STEP; }

    // Camera at predicted position, with a little walk bob
    var d = Shared.dims(me.crouch);
    var speed = Math.hypot(me.vx, me.vz);
    bobPhase += speed * dt * 1.7;
    var bob = Math.abs(Math.sin(bobPhase)) * Math.min(0.05, speed / CONFIG.BASE_SPEED * 0.05);
    camera.position.set(me.x, me.y + d.eye + bob, me.z);
    camera.rotation.set(pitch, yaw, 0);

    if (window.Audio2) Audio2.setListener(me.x, me.y + d.eye, me.z, yaw);
    footstepAudio(dt, speed);

    updateBillboards(dt);
    updateWorldObjects(dt, nowP);
    updateViewmodel(dt);
    updateHudTick();
    updatePrompt();
  }

  // impacts
  for (var i = impacts.length - 1; i >= 0; i--) {
    var e = impacts[i]; e.life -= dt;
    if (e.life <= 0) { scene.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh.material.dispose(); impacts.splice(i,1); continue; }
    e.vel.y -= 9 * dt; e.mesh.position.addScaledVector(e.vel, dt);
  }

  renderer.render(scene, camera);
}

function updateBillboards(dt) {
  var renderTime = Date.now() + offset - CONFIG.INTERP_MS;
  for (var id in others) {
    var o = others[id], info = roster[id];
    if (!info) continue;
    if (!billboards[id]) billboards[id] = makeBillboard({ team: info.team, look: info.look, x: o.buffer[0] ? o.buffer[0].x : 0, z: o.buffer[0] ? o.buffer[0].z : 0 });
    var bb = billboards[id];
    bb.team = info.team; bb.look = info.look; bb.weapon = o.weapon; bb.wounds = o.wounds;

    var vis = !!o.alive;
    bb.sprite.visible = vis; bb.ring.visible = vis;
    if (!vis) continue;

    var buf = o.buffer, a = null, b = null;
    for (var k = buf.length - 1; k > 0; k--) {
      if (buf[k-1].t <= renderTime && renderTime <= buf[k].t) { a = buf[k-1]; b = buf[k]; break; }
    }
    var px, pz, py, byaw;
    if (a && b) {
      var span = b.t - a.t, fr = span > 0 ? (renderTime - a.t) / span : 0;
      px = a.x + (b.x-a.x)*fr; py = a.y + (b.y-a.y)*fr; pz = a.z + (b.z-a.z)*fr;
      var dy = b.yaw - a.yaw; while (dy > Math.PI) dy -= 6.283; while (dy < -Math.PI) dy += 6.283;
      byaw = a.yaw + dy * fr;
    } else if (buf.length) { var lp = buf[buf.length-1]; px = lp.x; py = lp.y; pz = lp.z; byaw = lp.yaw; }
    else continue;

    bb.sprite.position.set(px, py + 0.95, pz);
    bb.ring.position.set(px, py + 0.05, pz);
    lastBillboardPos.x = px; lastBillboardPos.z = pz;

    // animation: walking cycles carry frames, attacking plays the attack block
    var moving = Math.hypot(px - bb.lastX, pz - bb.lastZ) / dt > 0.5;
    bb.lastX = px; bb.lastZ = pz;
    var man = Sprites.manifest();
    if (bb.anim.block === 'attack') {
      bb.anim.t += dt;
      var af = man ? man.blocks.attack.frames : 6;
      bb.anim.frame = Math.floor(bb.anim.t / 0.06);
      if (bb.anim.frame >= af) bb.anim = { block: 'carry', frame: 0, t: 0 };
    } else if (moving) {
      bb.anim.t += dt * (o.speed || 4);
      var cf = man ? man.blocks.carry.frames : 9;
      bb.anim.frame = 1 + (Math.floor(bb.anim.t) % (cf - 1));
    } else { bb.anim.frame = 0; }

    drawBillboard(bb, facingToCamera(byaw));
  }
}

function updateViewmodel(dt) {
  if (vmState.swinging) {
    var w = weapon();
    var dur = w && w.kind === 'ranged' ? 0.28 : 0.32;
    vmState.swingT += dt / dur;
    if (vmState.swingT >= 1) { vmState.swinging = false; vmState.swingT = 0; }
    drawViewmodel(myWeapon);
    // small punch toward the screen on a swing
    viewmodel.position.y = -0.42 + Math.sin(Math.min(1, vmState.swingT) * Math.PI) * 0.06;
  } else {
    // idle sway
    viewmodel.position.x = 0.34 + Math.sin(performance.now() / 900) * 0.006;
    viewmodel.position.y = -0.42 + Math.cos(performance.now() / 700) * 0.006;
  }
  $('cross').classList.toggle('melee', weapon() && weapon().kind === 'melee');
  $('weapon').classList.toggle('cooling', false);
}

function updateHudTick() {
  if (matchPhase === 'live') {
    var left = Math.max(0, matchEndsAt - (Date.now() + offset));
    var mm = Math.floor(left/60000), ss = Math.floor((left%60000)/1000);
    $('clock').textContent = mm + ':' + (ss<10?'0':'') + ss;
  }
}

function updatePrompt() {
  if (!alive) { $('prompt').style.display = 'none'; return; }
  var near = null;
  MAP.pedestals.forEach(function (p, i) {
    if (!pedestalReady[i]) return;
    if (Math.hypot(me.x - p.x, me.z - p.z) < CONFIG.PICKUP_RANGE) near = p;
  });
  if (near && Shared.WEAPON_BY_ID[near.id].index !== myWeapon) {
    $('promptWep').textContent = Shared.WEAPON_BY_ID[near.id].name;
    $('prompt').style.display = 'block';
  } else $('prompt').style.display = 'none';
}

// ===========================================================================
// Menu + character customization
// ===========================================================================

var LABELS = {
  body_light: 'Fair', body_brown: 'Tan', body_dark: 'Dark',
  torso_chain: 'Chainmail', torso_plate: 'Plate', torso_leather: 'Leather',
  hair_messy: 'Messy', hair_long: 'Long', hair_bald: 'Bald'
};

function buildChoices(containerId, key, options) {
  var c = $(containerId); c.innerHTML = '';
  options.forEach(function (opt) {
    var el = document.createElement('div');
    el.className = 'choice' + (look[key] === opt ? ' sel' : '');
    el.textContent = LABELS[opt] || opt;
    el.onclick = function () {
      look[key] = opt;
      [].forEach.call(c.children, function (ch) { ch.classList.remove('sel'); });
      el.classList.add('sel');
      drawPreview();
    };
    c.appendChild(el);
  });
}

function drawPreview() {
  var cvs = $('preview'); var ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = false; ctx.clearRect(0,0,64,64);
  if (!Sprites.ready()) return;
  var sheet = Sprites.characterSheet(look, 'a', 0);
  if (sheet) { var r = Sprites.frameRect('carry', 'south', 0); ctx.drawImage(sheet, r.sx, r.sy, 64, 64, 0, 0, 64, 64); }
}

function buildBotChoices() {
  var c = $('chBots'); c.innerHTML = '';
  [1,3,5].forEach(function (n) {
    var el = document.createElement('div'); el.className = 'choice' + (n === chosenBots ? ' sel' : '');
    el.textContent = n; el.onclick = function () { chosenBots = n;
      [].forEach.call(c.children, function(x){x.classList.remove('sel');}); el.classList.add('sel'); };
    c.appendChild(el);
  });
  var s = $('chSkill'); s.innerHTML = '';
  [['recruit','Easy'],['regular','Normal'],['veteran','Hard']].forEach(function (pair) {
    var el = document.createElement('div'); el.className = 'choice' + (pair[0] === chosenSkill ? ' sel' : '');
    el.textContent = pair[1]; el.onclick = function () { chosenSkill = pair[0];
      [].forEach.call(s.children, function(x){x.classList.remove('sel');}); el.classList.add('sel'); };
    s.appendChild(el);
  });
}

function callsign() { return ($('name').value || '').trim() || 'squire'; }

// The browser blocks audio until a gesture. Unlock on the first click or key,
// and start the menu music then.
var audioStarted = false;
function startAudio() {
  if (audioStarted || !window.Audio2) return;
  audioStarted = true;
  Audio2.unlock();
  if (!myId) Audio2.menuMusic();
}
addEventListener('pointerdown', startAudio, { once: false });
addEventListener('keydown', startAudio, { once: false });

$('soundToggle').addEventListener('click', function (e) {
  e.stopPropagation();
  if (!window.Audio2) return;
  var muted = !Audio2.isMuted();
  Audio2.setMuted(muted);
  this.innerHTML = muted ? '&#128263; sound off' : '&#128266; sound on';
});

$('goOffline').onclick = function () {
  $('goOnline').disabled = true; $('goOffline').disabled = true; status('');
  connect(callsign(), { bots: chosenBots, skill: chosenSkill });
};
$('goOnline').onclick = function () {
  $('goOnline').disabled = true; $('goOffline').disabled = true; status('Connecting...');
  connect(callsign());
};
$('name').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('goOffline').click(); });

// ===========================================================================
// Boot
// ===========================================================================

Sprites.loadAll().then(function () {
  $('loading').style.display = 'none';
  buildChoices('chBody', 'body', ['body_light','body_brown','body_dark']);
  buildChoices('chTorso', 'torso', ['torso_chain','torso_plate','torso_leather']);
  buildChoices('chHair', 'hair', ['hair_messy','hair_long','hair_bald']);
  buildBotChoices();
  drawPreview();
  $('name').focus();
});

// Audio loads in the background; it only makes noise after the first gesture.
if (window.Audio2) Audio2.load();

frame();

})();
