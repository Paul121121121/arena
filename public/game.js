// game.js
// The rules of the game, with no idea how messages reach anyone.
//
// The Node server wraps this in WebSockets. Offline mode runs the same object
// in the browser and delivers messages by calling a function. One copy of the
// rules, so the two cannot drift apart. Bots are players whose inputs come
// from bots.js instead of a socket - the simulation cannot tell them apart.

(function (exports, Shared) {
  'use strict';

  const { CONFIG, MAP, WEAPONS, FISTS } = Shared;
  const now = () => Date.now();
  const other = t => (t === 'a' ? 'b' : 'a');

  function GameHost(opts) {
    opts = opts || {};
    this.send = opts.send || function () {};
    this.config = Object.assign({}, CONFIG, opts.config || {});
    this.players = new Map();
    this.projectiles = [];
    this.nextId = 1;
    this.nextProjectile = 1;
    this.tickCount = 0;
    this.tickMs = 1000 / this.config.TICK_HZ;
    this.snapEvery = Math.max(1, Math.round(this.config.TICK_HZ / this.config.SNAPSHOT_HZ));

    this.match = {
      phase: 'live', scores: { a: 0, b: 0 },
      endsAt: now() + this.config.ROUND_MS, number: 1
    };

    this.flags = {
      a: { team: 'a', state: 'home', x: MAP.flags.a.x, y: 0, z: MAP.flags.a.z, carrier: null, droppedAt: 0 },
      b: { team: 'b', state: 'home', x: MAP.flags.b.x, y: 0, z: MAP.flags.b.z, carrier: null, droppedAt: 0 }
    };

    this.pedestals = MAP.pedestals.map((p, i) => ({
      idx: i, weapon: p.id, x: p.x, z: p.z, ready: true, readyAt: 0
    }));

    this.medkits = [];
    this.resetMedkits();
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  GameHost.prototype.broadcast = function (msg) {
    for (const p of this.players.values()) this.send(p.id, msg);
  };

  GameHost.prototype.rosterEntry = function (p) {
    return {
      id: p.id, name: p.name, team: p.team, bot: !!p.bot,
      k: p.kills, d: p.deaths, caps: p.captures, ret: p.returns, look: p.look
    };
  };

  GameHost.prototype.sendRoster = function () {
    this.broadcast({ type: 'roster', players: [...this.players.values()].map(p => this.rosterEntry(p)) });
  };

  // -------------------------------------------------------------------------
  // Teams and spawning
  // -------------------------------------------------------------------------

  GameHost.prototype.randomiseTeams = function () {
    const assignment = Shared.balancedShuffle([...this.players.keys()]);
    for (const id in assignment) this.players.get(Number(id)).team = assignment[id];
  };

  GameHost.prototype.assignTeam = function () {
    let a = 0, b = 0;
    for (const p of this.players.values()) p.team === 'a' ? a++ : b++;
    if (a === b) return Math.random() < 0.5 ? 'a' : 'b';
    return a < b ? 'a' : 'b';
  };

  GameHost.prototype.pickSpawn = function (team) {
    const list = MAP.spawns[team];
    let best = list[0], bestScore = -Infinity;
    for (const s of list) {
      let score = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - s.x, p.z - s.z);
        score = Math.min(score, d * (p.team === team ? 0.35 : 1));
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  };

  GameHost.prototype.respawn = function (p) {
    const s = this.pickSpawn(p.team);
    p.x = s.x; p.y = 0; p.z = s.z;
    p.vx = p.vy = p.vz = 0;
    p.yaw = s.yaw; p.pitch = 0;
    p.crouch = false; p.jumps = 0;
    p.health = this.config.MAX_HEALTH;
    p.stamina = this.config.MAX_STAMINA;
    p.alive = true;
    p.weapon = FISTS;                       // always respawn with only fists
    p.wounds = [];
    p.attackUntil = 0; p.nextAttackAt = 0; p.windupUntil = 0; p.pendingSwing = null;
    p.blocking = false;
    p.protectedUntil = now() + this.config.SPAWN_PROTECT_MS;
    p.recentDamage.clear();
    p.history.length = 0;
  };

  // -------------------------------------------------------------------------
  // Joining
  // -------------------------------------------------------------------------

  const LOOK_OPTIONS = {
    body: ['body_light', 'body_brown', 'body_dark'],
    torso: ['torso_chain', 'torso_plate', 'torso_leather'],
    hair: ['hair_messy', 'hair_long', 'hair_bald']
  };

  function sanitiseLook(look) {
    look = look || {};
    const pick = (k, v) => LOOK_OPTIONS[k].indexOf(v) >= 0 ? v : LOOK_OPTIONS[k][0];
    return { body: pick('body', look.body), torso: pick('torso', look.torso), hair: pick('hair', look.hair) };
  }

  GameHost.prototype.join = function (rawName, options) {
    options = options || {};
    if (this.players.size >= this.config.MAX_PLAYERS) return null;

    const name = String(rawName || 'squire').slice(0, 14).replace(/[<>&"']/g, '').trim() || 'squire';
    const team = options.team || this.assignTeam();
    const id = this.nextId++;
    const s = this.pickSpawn(team);

    const p = {
      id, name, team,
      bot: !!options.bot,
      look: sanitiseLook(options.look),
      x: s.x, y: 0, z: s.z, vx: 0, vy: 0, vz: 0,
      yaw: s.yaw, pitch: 0, crouch: false, onGround: true, jumps: 0,
      health: this.config.MAX_HEALTH,
      stamina: this.config.MAX_STAMINA,
      alive: true, respawnAt: 0,
      protectedUntil: now() + this.config.SPAWN_PROTECT_MS,
      weapon: FISTS, wounds: [],
      attackUntil: 0, nextAttackAt: 0, windupUntil: 0, pendingSwing: null, blocking: false,
      carrying: null,
      kills: 0, deaths: 0, captures: 0, returns: 0, damageDealt: 0,
      recentDamage: new Map(),
      lastSeq: 0, inputQueue: [], history: [],
      rtt: options.bot ? 0 : 60, budget: 0.2
    };
    this.players.set(id, p);

    const welcome = {
      type: 'welcome', id: id, team: team,
      config: this.config, weapons: WEAPONS, map: MAP, lookOptions: LOOK_OPTIONS,
      match: { phase: this.match.phase, scores: this.match.scores, endsAt: this.match.endsAt, number: this.match.number },
      you: { x: p.x, y: p.y, z: p.z, yaw: p.yaw },
      players: [...this.players.values()].map(q => this.rosterEntry(q))
    };

    this.broadcast({ type: 'joined', id: id, name: name, team: team, bot: !!options.bot });
    this.sendRoster();
    if (this.humanCount() === 1 && this.match.phase === 'intermission') this.startMatch();
    return { id: id, welcome: welcome, player: p };
  };

  GameHost.prototype.humanCount = function () {
    let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n;
  };

  GameHost.prototype.leave = function (id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.carrying) this.dropFlag(p, 'left');
    this.players.delete(id);
    this.broadcast({ type: 'left', id: id, name: p.name });
    this.sendRoster();
  };

  // -------------------------------------------------------------------------
  // Lag compensation
  // -------------------------------------------------------------------------

  function recordHistory(p, t) {
    p.history.push({ t, x: p.x, y: p.y, z: p.z, crouch: p.crouch });
    // Trim by age, and hard-cap the count so the buffer can never grow without
    // bound (at 60Hz, 1.2s of history is ~72 samples; 150 is generous headroom).
    while (p.history.length && t - p.history[0].t > 1200) p.history.shift();
    while (p.history.length > 150) p.history.shift();
  }

  function positionAt(p, t) {
    const h = p.history;
    if (!h.length) return { x: p.x, y: p.y, z: p.z, crouch: p.crouch };
    if (t >= h[h.length - 1].t) return h[h.length - 1];
    if (t <= h[0].t) return h[0];
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= t && t <= h[i].t) {
        const a = h[i - 1], b = h[i];
        const span = b.t - a.t, f = span > 0 ? (t - a.t) / span : 0;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, crouch: b.crouch };
      }
    }
    return h[h.length - 1];
  }

  GameHost.prototype.enemiesOf = function (p, rewindTo) {
    const out = [], t = now();
    for (const q of this.players.values()) {
      if (q === p || !q.alive || q.team === p.team) continue;
      if (q.protectedUntil > t) continue;
      const at = rewindTo ? positionAt(q, rewindTo) : q;
      out.push({ id: q.id, ref: q, x: at.x, y: at.y, z: at.z, crouch: at.crouch });
    }
    return out;
  };

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  const WOUNDS = ['wound_ribs', 'wound_brain', 'wound_eye'];

  GameHost.prototype.damage = function (attacker, victim, amount, opts) {
    opts = opts || {};
    const t = now();
    if (!victim.alive || victim.protectedUntil > t) return;

    // Blocking: facing the attacker with a melee weapon up cuts damage hard
    // and drains stamina instead. Mordhau's core exchange in miniature.
    if (victim.blocking && victim.stamina > 0 && !opts.projectileFromBehind) {
      const toAtt = Math.atan2(attacker.x - victim.x, -(attacker.z - victim.z));
      let facing = toAtt - victim.yaw;
      while (facing > Math.PI) facing -= Math.PI * 2;
      while (facing < -Math.PI) facing += Math.PI * 2;
      if (Math.abs(facing) < 1.1) {                 // within the block arc
        const drained = Math.min(victim.stamina, amount * 1.5);
        victim.stamina -= drained;
        amount *= (victim.stamina <= 0) ? 0.6 : 0.12;  // guard broken if drained
        this.send(victim.id, { type: 'blocked', stamina: Math.round(victim.stamina) });
        this.send(attacker.id, { type: 'blockedby' });
      }
    }

    amount = Math.round(amount);
    if (amount <= 0) return;

    victim.health -= amount;
    attacker.damageDealt += amount;

    const rec = victim.recentDamage.get(attacker.id) || { amount: 0, at: 0 };
    rec.amount += amount; rec.at = t;
    victim.recentDamage.set(attacker.id, rec);

    const hurtFraction = 1 - victim.health / this.config.MAX_HEALTH;
    const wanted = Math.min(WOUNDS.length, Math.floor(hurtFraction * 3.2));
    while (victim.wounds.length < wanted) {
      const pool = WOUNDS.filter(w => victim.wounds.indexOf(w) < 0);
      if (!pool.length) break;
      victim.wounds.push(pool[Math.floor(Math.random() * pool.length)]);
    }

    this.send(attacker.id, { type: 'hitmarker', head: !!opts.head, dmg: amount, lethal: victim.health <= 0 });
    this.send(victim.id, { type: 'hurt', health: Math.max(0, victim.health), by: attacker.name, fx: attacker.x, fz: attacker.z, wounds: victim.wounds });

    if (victim.health <= 0) this.kill(attacker, victim, opts.weapon, !!opts.head);
  };

  GameHost.prototype.kill = function (killer, victim, weaponId, head) {
    const t = now();
    victim.alive = false;
    victim.deaths++;
    victim.respawnAt = t + this.config.RESPAWN_MS;
    if (killer !== victim) killer.kills++;
    if (victim.carrying) this.dropFlag(victim, 'killed');
    this.broadcast({
      type: 'kill', killer: killer.name, killerId: killer.id, killerTeam: killer.team,
      victim: victim.name, victimId: victim.id, victimTeam: victim.team,
      weapon: weaponId || 'fists', head: !!head,
      dist: Math.round(Math.hypot(killer.x - victim.x, killer.z - victim.z))
    });
    this.sendRoster();
  };

  // -------------------------------------------------------------------------
  // Attacking. Melee has a short wind-up before it lands, so a swing can be
  // seen coming and blocked - the thing that makes melee a duel, not a click
  // race. Ranged launches a real arrow.
  // -------------------------------------------------------------------------

  GameHost.prototype.startAttack = function (p) {
    const t = now();
    if (!p.alive || this.match.phase !== 'live') return;
    if (t < p.nextAttackAt || p.pendingSwing) return;
    if (p.blocking) return;

    const w = WEAPONS[p.weapon];
    const cost = w.staminaCost || 0;
    if (p.stamina < cost) { this.send(p.id, { type: 'exhausted' }); return; }
    p.stamina -= cost;

    if (w.kind === 'melee') {
      p.windupUntil = t + w.windupMs;
      p.pendingSwing = { at: p.windupUntil, weapon: p.weapon };
      p.nextAttackAt = t + w.cooldownMs;
      p.attackUntil = t + Math.min(500, w.cooldownMs * 0.75);
      this.broadcast({ type: 'windup', id: p.id, w: w.id, ms: w.windupMs });
    } else {
      p.nextAttackAt = t + w.cooldownMs;
      p.attackUntil = t + 300;
      p.protectedUntil = 0;
      this.loose(p, w);
    }
  };

  // The melee swing actually connects here, windupMs after the button
  GameHost.prototype.resolveSwing = function (p) {
    const swing = p.pendingSwing;
    p.pendingSwing = null;
    if (!p.alive) return;
    const w = WEAPONS[swing.weapon];
    if (p.weapon !== swing.weapon) return;        // switched weapon mid-swing
    p.protectedUntil = 0;

    const t = now();
    const rewindTo = t - Math.min(p.rtt / 2, 250) - this.config.INTERP_MS;
    const targets = this.enemiesOf(p, rewindTo);
    const hits = Shared.meleeHits(p, w, targets);

    this.broadcast({ type: 'swing', id: p.id, w: w.id, hit: hits.length > 0 });
    for (const h of hits) {
      this.damage(p, h.target.ref, w.damage * (h.head ? w.headMul : 1), { head: h.head, weapon: w.id });
    }
  };

  GameHost.prototype.loose = function (p, w) {
    const d = Shared.dims(p.crouch);
    const aim = Shared.dirFromAngles(p.yaw, p.pitch);
    const pr = {
      id: this.nextProjectile++, owner: p.id, team: p.team, weapon: w.id,
      damage: w.damage, headMul: w.headMul, drop: w.drop,
      x: p.x + aim.x * 0.6, y: p.y + d.eye - 0.12 + aim.y * 0.6, z: p.z + aim.z * 0.6,
      px: p.x, py: p.y + d.eye - 0.12, pz: p.z,
      vx: aim.x * w.speed, vy: aim.y * w.speed, vz: aim.z * w.speed, life: 5
    };
    this.projectiles.push(pr);
    this.broadcast({ type: 'loose', id: p.id, w: w.id });
  };

  GameHost.prototype.stepProjectiles = function (dt) {
    const t = now();
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      Shared.stepProjectile(pr, dt);
      const owner = this.players.get(pr.owner);
      const targets = [];
      for (const q of this.players.values()) {
        if (!q.alive || q.id === pr.owner || q.team === pr.team) continue;
        if (q.protectedUntil > t) continue;
        targets.push({ id: q.id, ref: q, x: q.x, y: q.y, z: q.z, crouch: q.crouch });
      }
      const hit = Shared.projectileHit(pr, targets);
      if (hit) {
        this.broadcast({ type: 'impact', id: pr.id, x: +hit.x.toFixed(2), y: +hit.y.toFixed(2), z: +hit.z.toFixed(2), kind: hit.kind, surface: hit.surface || null });
        if (hit.kind === 'player' && owner) {
          this.damage(owner, hit.target.ref, pr.damage * (hit.head ? pr.headMul : 1), { head: hit.head, weapon: pr.weapon });
        }
        this.projectiles.splice(i, 1);
        continue;
      }
      if (pr.life <= 0 || Math.abs(pr.x) > MAP.width || Math.abs(pr.z) > MAP.depth || pr.y < -5) {
        this.broadcast({ type: 'impact', id: pr.id, x: pr.x, y: pr.y, z: pr.z, kind: 'expire' });
        this.projectiles.splice(i, 1);
      }
    }
  };

  // -------------------------------------------------------------------------
  // Pickups
  // -------------------------------------------------------------------------

  GameHost.prototype.resetMedkits = function () {
    const spots = MAP.medkitSpots.slice().sort(() => Math.random() - 0.5);
    this.medkits = spots.slice(0, 3).map((s, i) => ({ idx: i, x: s.x, z: s.z, ready: true, readyAt: 0 }));
  };

  GameHost.prototype.moveMedkit = function (kit) {
    const taken = this.medkits.filter(k => k !== kit).map(k => k.x + ',' + k.z);
    const free = MAP.medkitSpots.filter(s => taken.indexOf(s.x + ',' + s.z) < 0);
    const spot = free[Math.floor(Math.random() * free.length)];
    kit.x = spot.x; kit.z = spot.z;
  };

  GameHost.prototype.tryPickup = function (p) {
    if (!p.alive || this.match.phase !== 'live') return;
    let best = null, bestDist = Infinity;
    for (const ped of this.pedestals) {
      if (!ped.ready) continue;
      const d = Math.hypot(p.x - ped.x, p.z - ped.z);
      if (d < this.config.PICKUP_RANGE && d < bestDist) { bestDist = d; best = ped; }
    }
    if (!best) return;
    const w = Shared.WEAPON_BY_ID[best.weapon];
    if (!w || p.weapon === w.index) return;
    const dropped = WEAPONS[p.weapon];
    p.weapon = w.index;
    best.ready = false;
    best.readyAt = now() + this.config.WEAPON_RESPAWN_MS;
    this.send(p.id, { type: 'picked', weapon: w.id, replaced: dropped.id });
    this.broadcast({ type: 'pedestal', idx: best.idx, ready: false });
  };

  GameHost.prototype.checkMedkits = function (p) {
    if (!p.alive || p.health >= this.config.MAX_HEALTH) return;
    for (const kit of this.medkits) {
      if (!kit.ready) continue;
      if (Math.hypot(p.x - kit.x, p.z - kit.z) > this.config.PICKUP_RANGE) continue;
      p.health = Math.min(this.config.MAX_HEALTH, p.health + this.config.MEDKIT_HEAL);
      const keep = Math.floor((1 - p.health / this.config.MAX_HEALTH) * 3.2);
      p.wounds = p.wounds.slice(0, Math.max(0, keep));
      kit.ready = false;
      kit.readyAt = now() + this.config.MEDKIT_RESPAWN_MS;
      this.send(p.id, { type: 'healed', health: p.health, wounds: p.wounds });
      this.broadcast({ type: 'medkit', idx: kit.idx, ready: false });
      return;
    }
  };

  // -------------------------------------------------------------------------
  // Flags
  // -------------------------------------------------------------------------

  GameHost.prototype.flagState = function () {
    const out = {};
    for (const key of ['a', 'b']) {
      const f = this.flags[key];
      out[key] = { state: f.state, x: +f.x.toFixed(2), y: +f.y.toFixed(2), z: +f.z.toFixed(2), carrier: f.carrier };
    }
    return out;
  };

  GameHost.prototype.dropFlag = function (p, reason) {
    const key = p.carrying;
    if (!key) return;
    const f = this.flags[key];
    f.state = 'dropped'; f.carrier = null;
    f.x = p.x; f.y = p.y; f.z = p.z; f.droppedAt = now();
    p.carrying = null;
    this.broadcast({ type: 'flag', team: key, event: 'dropped', by: p.name, reason: reason || 'dropped' });
  };

  GameHost.prototype.returnFlag = function (key, by) {
    const f = this.flags[key];
    f.state = 'home'; f.carrier = null;
    f.x = MAP.flags[key].x; f.y = 0; f.z = MAP.flags[key].z;
    this.broadcast({ type: 'flag', team: key, event: 'returned', by: by || null });
  };

  GameHost.prototype.checkFlags = function (p) {
    if (!p.alive || this.match.phase !== 'live') return;
    const mine = this.flags[p.team];
    const theirs = this.flags[other(p.team)];
    const range = this.config.FLAG_PICKUP_RANGE;

    if (!p.carrying && theirs.state !== 'carried' && Math.hypot(p.x - theirs.x, p.z - theirs.z) < range) {
      theirs.state = 'carried'; theirs.carrier = p.id; p.carrying = theirs.team;
      this.broadcast({ type: 'flag', team: theirs.team, event: 'taken', by: p.name, byId: p.id });
    }
    if (mine.state === 'dropped' && Math.hypot(p.x - mine.x, p.z - mine.z) < range) {
      p.returns++; this.returnFlag(p.team, p.name); this.sendRoster();
    }
    if (p.carrying) {
      const stand = MAP.flags[p.team];
      // Classic CTF rule: your own flag must be home to score.
      const ownHome = this.flags[p.team].state === 'home';
      if (ownHome && Math.hypot(p.x - stand.x, p.z - stand.z) < range + 0.6) {
        const key = p.carrying;
        p.carrying = null; p.captures++; this.match.scores[p.team]++;
        this.returnFlag(key, null);
        this.broadcast({ type: 'capture', team: p.team, by: p.name, byId: p.id, scores: this.match.scores });
        this.sendRoster();
        if (this.match.scores[p.team] >= this.config.CAPTURES_TO_WIN) this.endMatch(p.team);
      }
    }
  };

  GameHost.prototype.updateFlags = function () {
    const t = now();
    for (const key of ['a', 'b']) {
      const f = this.flags[key];
      if (f.state === 'carried') {
        const carrier = this.players.get(f.carrier);
        if (!carrier || !carrier.alive) {
          if (carrier) this.dropFlag(carrier, 'lost');
          else { f.state = 'dropped'; f.carrier = null; f.droppedAt = t; }
          continue;
        }
        f.x = carrier.x; f.y = carrier.y; f.z = carrier.z;
      } else if (f.state === 'dropped' && t - f.droppedAt > this.config.FLAG_RETURN_MS) {
        this.returnFlag(key, null);
      }
    }
  };

  // -------------------------------------------------------------------------
  // Match flow
  // -------------------------------------------------------------------------

  GameHost.prototype.startMatch = function () {
    this.match.phase = 'live';
    this.match.scores = { a: 0, b: 0 };
    this.match.endsAt = now() + this.config.ROUND_MS;
    this.match.number++;
    this.randomiseTeams();
    this.projectiles.length = 0;
    this.returnFlag('a', null); this.returnFlag('b', null);
    this.pedestals.forEach(p => { p.ready = true; p.readyAt = 0; });
    this.resetMedkits();
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.captures = 0; p.returns = 0; p.damageDealt = 0;
      p.carrying = null;
      this.respawn(p);
    }
    const teams = {};
    for (const p of this.players.values()) teams[p.id] = p.team;
    this.broadcast({
      type: 'match-start', number: this.match.number, endsAt: this.match.endsAt,
      scores: this.match.scores, teams: teams,
      pedestals: this.pedestals.map(p => ({ idx: p.idx, ready: p.ready })),
      medkits: this.medkits.map(k => ({ idx: k.idx, x: k.x, z: k.z, ready: k.ready }))
    });
    this.sendRoster();
    for (const p of this.players.values()) {
      this.send(p.id, { type: 'respawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw, team: p.team });
    }
  };

  GameHost.prototype.endMatch = function (winner) {
    this.match.phase = 'intermission';
    this.match.endsAt = now() + this.config.INTERMISSION_MS;
    this.broadcast({
      type: 'match-end', winner: winner, scores: this.match.scores, nextIn: this.config.INTERMISSION_MS,
      stats: [...this.players.values()]
        .map(p => ({ name: p.name, team: p.team, k: p.kills, d: p.deaths, caps: p.captures, ret: p.returns, dmg: p.damageDealt }))
        .sort((x, y) => (y.caps - x.caps) || (y.k - x.k))
    });
  };

  // -------------------------------------------------------------------------
  // Incoming messages
  // -------------------------------------------------------------------------

  GameHost.prototype.handle = function (id, msg) {
    const p = this.players.get(id);
    if (!p || !msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'input': {
        if (typeof msg.seq !== 'number' || !isFinite(msg.seq)) return;
        if (p.inputQueue.length > 70) return;
        p.inputQueue.push({
          seq: msg.seq,
          dt: Math.min(Math.max(Number(msg.dt) || 0, 0), this.config.MAX_INPUT_DT),
          forward: Math.max(-1, Math.min(1, Number(msg.forward) || 0)),
          right: Math.max(-1, Math.min(1, Number(msg.right) || 0)),
          jumpEdge: !!msg.jumpEdge, crouch: !!msg.crouch, sprint: !!msg.sprint,
          attack: !!msg.attack, block: !!msg.block, use: !!msg.use,
          yaw: isFinite(msg.yaw) ? Number(msg.yaw) : p.yaw,
          pitch: Math.max(-1.54, Math.min(1.54, Number(msg.pitch) || 0))
        });
        break;
      }
      case 'pong': {
        const rtt = now() - (Number(msg.t) || now());
        p.rtt = p.rtt * 0.8 + Math.max(0, Math.min(600, rtt)) * 0.2;
        this.send(p.id, { type: 'ping', value: Math.round(p.rtt) });
        break;
      }
    }
  };

  // -------------------------------------------------------------------------
  // One tick
  // -------------------------------------------------------------------------

  GameHost.prototype.tick = function () {
    const t = now();
    this.tickCount++;
    const dt = this.tickMs / 1000;

    if (this.match.phase === 'intermission' && t >= this.match.endsAt) {
      if (this.humanCount() > 0) this.startMatch();
      else this.match.endsAt = t + this.config.INTERMISSION_MS;
    }
    if (this.match.phase === 'live' && t >= this.match.endsAt) {
      this.endMatch(this.match.scores.a === this.match.scores.b ? null : this.match.scores.a > this.match.scores.b ? 'a' : 'b');
    }

    for (const ped of this.pedestals) {
      if (!ped.ready && t >= ped.readyAt) { ped.ready = true; this.broadcast({ type: 'pedestal', idx: ped.idx, ready: true }); }
    }
    for (const kit of this.medkits) {
      if (!kit.ready && t >= kit.readyAt) {
        this.moveMedkit(kit); kit.ready = true;
        this.broadcast({ type: 'medkit', idx: kit.idx, x: kit.x, z: kit.z, ready: true });
      }
    }

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.match.phase === 'live' && t >= p.respawnAt) {
          this.respawn(p);
          this.send(p.id, { type: 'respawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw, team: p.team });
        }
        continue;
      }

      // Stamina regenerates unless you are actively blocking
      if (!p.blocking && p.stamina < this.config.MAX_STAMINA) {
        p.stamina = Math.min(this.config.MAX_STAMINA, p.stamina + this.config.STAMINA_REGEN * dt);
      }

      p.budget = Math.min(0.25, p.budget + dt * 1.15);
      const w = WEAPONS[p.weapon];
      const queue = p.inputQueue;
      p.inputQueue = [];
      for (const input of queue) {
        if (input.seq <= p.lastSeq) continue;
        // You cannot block with a bow, and blocking stops you attacking
        p.blocking = !!input.block && w.kind === 'melee' && p.stamina > 0;
        const allowed = Math.min(input.dt, Math.max(0, p.budget));
        p.budget -= input.dt;
        Shared.stepPlayer(p, input, allowed, w, !!p.carrying);
        p.onGround = p.y <= Shared.groundHeight(p.x, p.z, p.y) + 0.03;
        p.lastSeq = input.seq;
        if (input.attack) this.startAttack(p);
        if (input.use) this.tryPickup(p);
      }

      // Land a melee swing once its wind-up elapses
      if (p.pendingSwing && t >= p.pendingSwing.at) this.resolveSwing(p);

      this.checkMedkits(p);
      this.checkFlags(p);
      recordHistory(p, t);
    }

    this.stepProjectiles(dt);
    this.updateFlags();

    if (this.tickCount % this.snapEvery === 0) this.sendSnapshot(t);
  };

  GameHost.prototype.snapshot = function (t) {
    const list = [];
    for (const p of this.players.values()) {
      list.push({
        id: p.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
        yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
        c: p.crouch ? 1 : 0, sp: Math.round(Math.hypot(p.vx, p.vz) * 10) / 10, g: p.onGround ? 1 : 0,
        h: p.health, st: Math.round(p.stamina), al: p.alive ? 1 : 0, w: p.weapon,
        atk: p.attackUntil > t ? 1 : 0, wu: p.pendingSwing ? 1 : 0, bl: p.blocking ? 1 : 0,
        wd: p.wounds.length, fl: p.carrying || null, pr: p.protectedUntil > t ? 1 : 0, seq: p.lastSeq
      });
    }
    const arrows = this.projectiles.map(pr => ({
      id: pr.id, x: +pr.x.toFixed(2), y: +pr.y.toFixed(2), z: +pr.z.toFixed(2),
      vx: +pr.vx.toFixed(1), vy: +pr.vy.toFixed(1), vz: +pr.vz.toFixed(1), w: pr.weapon
    }));
    return {
      type: 'snapshot', t: t || now(), players: list, arrows: arrows,
      flags: this.flagState(),
      peds: this.pedestals.map(p => (p.ready ? 1 : 0)),
      kits: this.medkits.map(k => ({ x: k.x, z: k.z, r: k.ready ? 1 : 0 }))
    };
  };

  GameHost.prototype.sendSnapshot = function (t) {
    const snap = this.snapshot(t);
    for (const p of this.players.values()) this.send(p.id, snap);
  };

  GameHost.prototype.pingAll = function () {
    const t = now();
    for (const p of this.players.values()) if (!p.bot) this.send(p.id, { type: 'ping-request', t: t });
  };

  exports.GameHost = GameHost;
  exports.LOOK_OPTIONS = LOOK_OPTIONS;

})(
  typeof module !== 'undefined' && module.exports ? module.exports : (window.Game = {}),
  typeof module !== 'undefined' && module.exports ? require('./shared.js') : window.Shared
);
