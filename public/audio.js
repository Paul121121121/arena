// audio.js
// Sound for Castle Clash. Two systems:
//   - SFX: short clips decoded once into buffers and played through the Web
//     Audio graph, with optional 3D positioning so a swing across the map is
//     quieter and off to one side.
//   - Music: streamed <audio> elements (they are large) with a simple
//     crossfade between menu and battle tracks.
//
// Browsers block audio until the first user gesture, so nothing plays until
// unlock() is called from a click/keypress.

(function (exports) {
  'use strict';

  var ctx = null;
  var master = null, sfxGain = null;
  var buffers = {};              // name -> AudioBuffer
  var listener = null;
  var unlocked = false;
  var settings = { master: 0.9, sfx: 0.9, music: 0.5, muted: false };

  // Which clips to load, and how they are used.
  var SFX_FILES = [
    'footstep', 'jump', 'swing', 'hit', 'hurt', 'bow', 'crossbow',
    'pickup', 'heal', 'block', 'death', 'flagtake', 'capture', 'lose'
  ];

  var MUSIC = {
    menu: '/audio/music/menu.mp3',
    battle: ['/audio/music/battle1.mp3', '/audio/music/battle2.mp3',
             '/audio/music/battle3.mp3', '/audio/music/battle4.mp3']
  };

  // ------------------------------------------------------------------ loading

  function load() {
    // Fetch and decode every SFX. Music is streamed, not decoded.
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return Promise.resolve();
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = settings.master;
    master.connect(ctx.destination);
    sfxGain = ctx.createGain(); sfxGain.gain.value = settings.sfx;
    sfxGain.connect(master);
    listener = ctx.listener;

    return Promise.all(SFX_FILES.map(function (name) {
      return fetch('/audio/sfx/' + name + '.ogg')
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) { return ctx.decodeAudioData(buf); })
        .then(function (decoded) { buffers[name] = decoded; })
        .catch(function () { /* a missing clip just goes silent */ });
    }));
  }

  // Call from the first user gesture.
  function unlock() {
    if (unlocked || !ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    unlocked = true;
  }

  // ------------------------------------------------------------------ listener

  // Update where the player's ears are and which way they face, so positioned
  // sounds pan and attenuate correctly.
  function setListener(x, y, z, yaw) {
    if (!ctx || !listener) return;
    var fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // forward vector from yaw
    if (listener.positionX) {
      listener.positionX.value = x; listener.positionY.value = y; listener.positionZ.value = z;
      listener.forwardX.value = fx; listener.forwardY.value = 0; listener.forwardZ.value = fz;
      listener.upX.value = 0; listener.upY.value = 1; listener.upZ.value = 0;
    } else if (listener.setPosition) {
      listener.setPosition(x, y, z);
      listener.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  // ------------------------------------------------------------------ playback

  // Play a clip. opts.at = {x,y,z} positions it in the world; opts.volume
  // scales it; opts.rate varies pitch a little for variety.
  function play(name, opts) {
    if (!ctx || !buffers[name] || settings.muted) return;
    if (ctx.state === 'suspended') return;
    opts = opts || {};

    var src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.playbackRate.value = opts.rate || 1;

    var gain = ctx.createGain();
    gain.gain.value = opts.volume == null ? 1 : opts.volume;

    if (opts.at) {
      var pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = 4;
      pan.maxDistance = 90;
      pan.rolloffFactor = 1.1;
      if (pan.positionX) { pan.positionX.value = opts.at.x; pan.positionY.value = opts.at.y; pan.positionZ.value = opts.at.z; }
      else if (pan.setPosition) pan.setPosition(opts.at.x, opts.at.y, opts.at.z);
      src.connect(gain); gain.connect(pan); pan.connect(sfxGain);
    } else {
      src.connect(gain); gain.connect(sfxGain);
    }
    try { src.start(0); } catch (e) {}
  }

  // Small random pitch so repeated sounds (footsteps, swings) do not machine-gun.
  function playVaried(name, opts) {
    opts = opts || {};
    opts.rate = (opts.rate || 1) * (0.94 + Math.random() * 0.12);
    play(name, opts);
  }

  // ------------------------------------------------------------------ music

  var musicEls = {};            // key -> HTMLAudioElement
  var currentMusic = null;
  var fadeTimer = null;

  function makeMusicEl(url) {
    var a = new Audio(url);
    a.loop = true;
    a.preload = 'none';
    a.volume = 0;
    return a;
  }

  // Play a track by url, crossfading from whatever is playing.
  function playMusic(url) {
    if (!url) return;
    if (currentMusic && currentMusic.src && currentMusic.src.indexOf(url) >= 0) return;

    var next = musicEls[url] || (musicEls[url] = makeMusicEl(url));
    var prev = currentMusic;
    currentMusic = next;

    next.volume = 0;
    var target = settings.muted ? 0 : settings.music;
    var p = next.play();
    if (p && p.catch) p.catch(function () {});   // autoplay may be blocked pre-gesture

    clearInterval(fadeTimer);
    var step = 0, steps = 30;
    fadeTimer = setInterval(function () {
      step++;
      var f = step / steps;
      next.volume = Math.min(target, target * f);
      if (prev) prev.volume = Math.max(0, (settings.muted ? 0 : settings.music) * (1 - f));
      if (step >= steps) {
        clearInterval(fadeTimer);
        if (prev && prev !== next) { prev.pause(); }
      }
    }, 40);
  }

  function menuMusic() { playMusic(MUSIC.menu); }
  function battleMusic() {
    // A different battle track each match, so it does not get stale.
    var list = MUSIC.battle;
    var url = list[Math.floor(Math.random() * list.length)];
    playMusic(url);
  }
  function stopMusic() {
    clearInterval(fadeTimer);
    if (currentMusic) { currentMusic.pause(); }
    currentMusic = null;
  }

  // ------------------------------------------------------------------ settings

  function setVolumes(v) {
    if (v.master != null) settings.master = v.master;
    if (v.sfx != null) settings.sfx = v.sfx;
    if (v.music != null) settings.music = v.music;
    if (master) master.gain.value = settings.master;
    if (sfxGain) sfxGain.gain.value = settings.sfx;
    if (currentMusic && !settings.muted) currentMusic.volume = settings.music;
  }
  function setMuted(on) {
    settings.muted = !!on;
    if (currentMusic) currentMusic.volume = on ? 0 : settings.music;
    if (master) master.gain.value = on ? 0 : settings.master;
  }
  function isMuted() { return settings.muted; }

  exports.load = load;
  exports.unlock = unlock;
  exports.setListener = setListener;
  exports.play = play;
  exports.playVaried = playVaried;
  exports.menuMusic = menuMusic;
  exports.battleMusic = battleMusic;
  exports.stopMusic = stopMusic;
  exports.setVolumes = setVolumes;
  exports.setMuted = setMuted;
  exports.isMuted = isMuted;

})(window.Audio2 = {});
