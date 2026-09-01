// game.js
// The rules of the game, with no idea how messages reach anyone.
//
// The Node server wraps this in WebSockets. Offline mode runs the exact same
// object inside the browser and delivers messages by calling a function. That
// is the point: one copy of the rules, so offline and online cannot drift
// apart. Bots are just players whose inputs come from bots.js instead of a
// socket - the simulation cannot tell the difference and does not care.

(function (exports, Shared) {
  'use strict';

  const { CONFIG, MAP, WEAPONS } = Shared;
  const SPREAD_RECOVER_DELAY_MS = 90;
  const now = () => Date.now();

  function GameHost(opts) {
    opts = opts || {};
    this.send = opts.send || function () {};      // send(playerId, message)
    this.config = Object.assign({}, CONFIG, opts.config || {});
    this.players = new Map();
    this.nextId = 1;
    this.tickCount = 0;
    this.tickMs = 1000 / this.config.TICK_HZ;
    this.snapEvery = Math.max(1, Math.round(this.config.TICK_HZ / this.config.SNAPSHOT_HZ));
    this.match = {
      phase: 'live',
      scores: { a: 0, b: 0 },
      endsAt: now() + this.config.ROUND_MS,
      number: 1
    };
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  GameHost.prototype.broadcast = function (msg) {
    for (const p of this.players.values()) this.send(p.id, msg);
  };

  GameHost.prototype.rosterEntry = function (p) {
    return { id: p.id, name: p.name, team: p.team, bot: !!p.bot, k: p.kills, d: p.deaths, a: p.assists };
  };

  GameHost.prototype.sendRoster = function () {
    this.broadcast({ type: 'roster', players: [...this.players.values()].map(p => this.rosterEntry(p)) });
  };

  // -------------------------------------------------------------------------
  // Teams
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

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  GameHost.prototype.pickSpawn = function (team) {
    const list = MAP.spawns[team];
    let best = list[0], bestScore = -Infinity;
    for (const s of list) {
      let score = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - s.x, p.z - s.z);
        const weight = p.team === team ? 0.35 : 1;
        score = Math.min(score, d * weight);
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  };

  function freshLoadout() {
    return WEAPONS.map(w => ({ ammo: w.mag, reserve: w.reserve }));
  }

  GameHost.prototype.respawn = function (p) {
    const s = this.pickSpawn(p.team);
    p.x = s.x; p.y = 0; p.z = s.z;
    p.vx = p.vy = p.vz = 0;
    p.yaw = s.yaw; p.pitch = 0;
    p.crouch = false;
    p.health = this.config.MAX_HEALTH;
    p.alive = true;
    p.loadout = freshLoadout();
    p.weapon = p.bot ? p.preferredWeapon || 0 : 0;
    p.consecutive = 0;
    p.reloadingUntil = 0;
    p.switchingUntil = 0;
    p.protectedUntil = now() + this.config.SPAWN_PROTECT_MS;
    p.recentDamage.clear();
    p.history.length = 0;
  };

  // -------------------------------------------------------------------------
  // Joining and leaving
  // -------------------------------------------------------------------------

  // Returns { id, welcome } or null if the room is full.
  GameHost.prototype.join = function (rawName, options) {
    options = options || {};
    if (this.players.size >= this.config.MAX_PLAYERS) return null;

    const name = String(rawName || 'player').slice(0, 14).replace(/[<>&"']/g, '').trim() || 'player';
    const team = options.team || this.assignTeam();
    const id = this.nextId++;
    const s = this.pickSpawn(team);

    const p = {
      id, name, team,
      bot: !!options.bot,
      preferredWeapon: options.weapon || 0,
      x: s.x, y: 0, z: s.z, vx: 0, vy: 0, vz: 0,
      yaw: s.yaw, pitch: 0, crouch: false, ads: false, onGround: true,
      health: this.config.MAX_HEALTH,
      alive: true,
      respawnAt: 0,
      protectedUntil: now() + this.config.SPAWN_PROTECT_MS,
      weapon: options.weapon || 0,
      loadout: freshLoadout(),
      consecutive: 0,
      lastShotAt: 0,
      reloadingUntil: 0,
      switchingUntil: 0,
      kills: 0, deaths: 0, assists: 0, damageDealt: 0,
      recentDamage: new Map(),
      lastSeq: 0,
      inputQueue: [],
      history: [],
      rtt: options.bot ? 0 : 60,
      budget: 0.2
    };
    this.players.set(id, p);

    const welcome = {
      type: 'welcome',
      id: id,
      team: team,
      config: this.config,
      weapons: WEAPONS,
      map: MAP,
      match: {
        phase: this.match.phase, scores: this.match.scores,
        endsAt: this.match.endsAt, number: this.match.number
      },
      you: { x: p.x, y: p.y, z: p.z, yaw: p.yaw },
      players: [...this.players.values()].map(q => this.rosterEntry(q))
    };

    this.broadcast({ type: 'joined', id: id, name: name, team: team, bot: !!options.bot });
    this.sendRoster();

    if (this.humanCount() === 1 && this.match.phase === 'intermission') this.startMatch();
    return { id: id, welcome: welcome, player: p };
  };

  GameHost.prototype.humanCount = function () {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot) n++;
    return n;
  };

  GameHost.prototype.leave = function (id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.broadcast({ type: 'left', id: id, name: p.name });
    this.sendRoster();
  };

  // -------------------------------------------------------------------------
  // Lag compensation
  //
  // You shoot at what you SEE, which is about half a ping old plus the 100ms
  // other players are deliberately held back by to keep them smooth. So rewind
  // everyone else to that moment before testing the shot.
  // -------------------------------------------------------------------------

  function recordHistory(p, t) {
    p.history.push({ t, x: p.x, y: p.y, z: p.z, crouch: p.crouch });
    while (p.history.length && t - p.history[0].t > 1200) p.history.shift();
  }

  function positionAt(p, t) {
    const h = p.history;
    if (!h.length) return { x: p.x, y: p.y, z: p.z, crouch: p.crouch };
    if (t >= h[h.length - 1].t) return h[h.length - 1];
    if (t <= h[0].t) return h[0];
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= t && t <= h[i].t) {
        const a = h[i - 1], b = h[i];
        const span = b.t - a.t;
        const f = span > 0 ? (t - a.t) / span : 0;
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          z: a.z + (b.z - a.z) * f,
          crouch: b.crouch
        };
      }
    }
    return h[h.length - 1];
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  function applySpread(d, spread) {
    if (spread <= 0) return d;
    let ux = -d.z, uy = 0, uz = d.x;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-6) { ux = 1; uy = 0; uz = 0; ul = 1; }   // aiming straight up or down
    ux /= ul; uy /= ul; uz /= ul;
    const vx = d.y * uz - d.z * uy;
    const vy = d.z * ux - d.x * uz;
    const vz = d.x * uy - d.y * ux;

    const ang = Math.random() * Math.PI * 2;
    const mag = Math.sqrt(Math.random()) * spread;   // sqrt keeps scatter even
    const ox = Math.cos(ang) * mag, oy = Math.sin(ang) * mag;

    const rx = d.x + ux * ox + vx * oy;
    const ry = d.y + uy * ox + vy * oy;
    const rz = d.z + uz * ox + vz * oy;
    const l = Math.hypot(rx, ry, rz);
    return { x: rx / l, y: ry / l, z: rz / l };
  }

  GameHost.prototype.creditAssists = function (victim, killerId) {
    const t = now();
    for (const [attackerId, rec] of victim.recentDamage) {
      if (attackerId === killerId) continue;
      if (t - rec.at > 8000) continue;
      if (rec.amount < 25) continue;
      const a = this.players.get(attackerId);
      if (a && a.team !== victim.team) a.assists++;
    }
  };

  GameHost.prototype.handleShot = function (shooter) {
    const t = now();
    if (!shooter.alive || this.match.phase !== 'live') return;
    if (t < shooter.reloadingUntil || t < shooter.switchingUntil) return;

    const w = WEAPONS[shooter.weapon];
    const slot = shooter.loadout[shooter.weapon];

    if (t - shooter.lastShotAt < w.fireMs - 6) return;      // server owns rate of fire
    if (slot.ammo <= 0) { this.send(shooter.id, { type: 'dryfire' }); return; }

    shooter.lastShotAt = t;
    slot.ammo--;
    shooter.protectedUntil = 0;                              // firing gives up protection

    const d0 = Shared.dims(shooter.crouch);
    const eye = { x: shooter.x, y: shooter.y + d0.eye, z: shooter.z };
    const aim = Shared.dirFromAngles(shooter.yaw, shooter.pitch);

    const spread = Shared.currentSpread(w, {
      consecutive: shooter.consecutive,
      vx: shooter.vx, vz: shooter.vz,
      onGround: shooter.onGround,
      crouch: shooter.crouch,
      ads: shooter.ads
    });
    shooter.consecutive++;

    const rewindTo = t - Math.min(shooter.rtt / 2, 250) - this.config.INTERP_MS;

    const targets = [];
    for (const other of this.players.values()) {
      if (other === shooter || !other.alive) continue;
      if (other.team === shooter.team) continue;             // no friendly fire
      if (other.protectedUntil > t) continue;                // just spawned
      targets.push({ p: other, at: positionAt(other, rewindTo) });
    }

    const beams = [];
    const damageByTarget = new Map();

    for (let i = 0; i < w.pellets; i++) {
      const d = applySpread(aim, spread);
      const wall = Shared.rayWall(eye.x, eye.y, eye.z, d.x, d.y, d.z, w.range);

      let hit = null;
      for (const tg of targets) {
        const r = Shared.rayPlayer(eye.x, eye.y, eye.z, d.x, d.y, d.z,
          tg.at.x, tg.at.y, tg.at.z, tg.at.crouch);
        if (r && r.t < wall.t && (!hit || r.t < hit.t)) hit = { t: r.t, zone: r.zone, target: tg.p };
      }

      const end = hit ? hit.t : wall.t;
      beams.push({
        ex: +(eye.x + d.x * end).toFixed(2),
        ey: +(eye.y + d.y * end).toFixed(2),
        ez: +(eye.z + d.z * end).toFixed(2),
        s: hit ? 'flesh' : (wall.kind || 'air'),
        nx: hit ? 0 : wall.nx, ny: hit ? 0 : wall.ny, nz: hit ? 0 : wall.nz
      });

      if (hit) {
        const dmg = Shared.damageAt(w, hit.zone, hit.t);
        const cur = damageByTarget.get(hit.target) || { amount: 0, head: false };
        cur.amount += dmg;
        if (hit.zone === 'head') cur.head = true;
        damageByTarget.set(hit.target, cur);
      }
    }

    this.broadcast({
      type: 'shot', id: shooter.id, w: w.id,
      ox: +eye.x.toFixed(2), oy: +eye.y.toFixed(2), oz: +eye.z.toFixed(2),
      beams: beams
    });
    this.send(shooter.id, { type: 'ammo', ammo: slot.ammo, reserve: slot.reserve });

    for (const [target, info] of damageByTarget) {
      const dmg = Math.round(info.amount);
      target.health -= dmg;
      shooter.damageDealt += dmg;

      const rec = target.recentDamage.get(shooter.id) || { amount: 0, at: 0 };
      rec.amount += dmg; rec.at = t;
      target.recentDamage.set(shooter.id, rec);

      this.send(shooter.id, { type: 'hitmarker', head: info.head, dmg: dmg, lethal: target.health <= 0 });
      this.send(target.id, {
        type: 'hurt', health: Math.max(0, target.health), by: shooter.name,
        fx: shooter.x, fz: shooter.z
      });

      if (target.health <= 0) {
        target.alive = false;
        target.deaths++;
        target.respawnAt = t + this.config.RESPAWN_MS;
        shooter.kills++;
        this.match.scores[shooter.team]++;
        this.creditAssists(target, shooter.id);

        this.broadcast({
          type: 'kill',
          killer: shooter.name, killerId: shooter.id, killerTeam: shooter.team,
          victim: target.name, victimId: target.id, victimTeam: target.team,
          weapon: w.id, head: info.head,
          dist: Math.round(Math.hypot(shooter.x - target.x, shooter.z - target.z))
        });
        this.broadcast({ type: 'score', scores: this.match.scores });
        this.sendRoster();

        if (this.match.scores[shooter.team] >= this.config.SCORE_LIMIT) this.endMatch(shooter.team);
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

    this.randomiseTeams();                     // fresh sides every match
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.assists = 0; p.damageDealt = 0;
      this.respawn(p);
    }

    const teams = {};
    for (const p of this.players.values()) teams[p.id] = p.team;

    this.broadcast({
      type: 'match-start',
      number: this.match.number,
      endsAt: this.match.endsAt,
      scores: this.match.scores,
      teams: teams
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
      type: 'match-end',
      winner: winner,
      scores: this.match.scores,
      nextIn: this.config.INTERMISSION_MS,
      stats: [...this.players.values()]
        .map(p => ({ name: p.name, team: p.team, k: p.kills, d: p.deaths, a: p.assists, dmg: p.damageDealt }))
        .sort((x, y) => y.k - x.k)
    });
  };

  // -------------------------------------------------------------------------
  // Incoming client messages
  // -------------------------------------------------------------------------

  GameHost.prototype.handle = function (id, msg) {
    const p = this.players.get(id);
    if (!p || !msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'input': {
        if (typeof msg.seq !== 'number' || !isFinite(msg.seq)) return;
        if (p.inputQueue.length > 70) return;              // flood guard
        p.inputQueue.push({
          seq: msg.seq,
          dt: Math.min(Math.max(Number(msg.dt) || 0, 0), this.config.MAX_INPUT_DT),
          forward: Math.max(-1, Math.min(1, Number(msg.forward) || 0)),
          right: Math.max(-1, Math.min(1, Number(msg.right) || 0)),
          jump: !!msg.jump,
          crouch: !!msg.crouch,
          sprint: !!msg.sprint,
          ads: !!msg.ads,
          shoot: !!msg.shoot,
          yaw: isFinite(msg.yaw) ? Number(msg.yaw) : p.yaw,
          pitch: Math.max(-1.54, Math.min(1.54, Number(msg.pitch) || 0))
        });
        break;
      }

      case 'switch': {
        const i = Number(msg.slot);
        if (!Number.isInteger(i) || i < 0 || i >= WEAPONS.length) return;
        if (i === p.weapon) return;
        const t = now();
        if (t < p.switchingUntil) return;
        p.weapon = i;
        p.reloadingUntil = 0;
        p.consecutive = 0;
        p.switchingUntil = t + WEAPONS[i].drawMs;
        const slot = p.loadout[i];
        this.send(p.id, {
          type: 'weapon', slot: i, drawMs: WEAPONS[i].drawMs,
          ammo: slot.ammo, reserve: slot.reserve
        });
        break;
      }

      case 'reload': {
        const t = now();
        const w = WEAPONS[p.weapon], slot = p.loadout[p.weapon];
        if (!p.alive || p.reloadingUntil || t < p.switchingUntil) break;
        if (slot.ammo >= w.mag || slot.reserve <= 0) break;
        p.reloadingUntil = t + w.reloadMs;
        this.send(p.id, { type: 'reloading', ms: w.reloadMs });
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
  // One simulation tick
  // -------------------------------------------------------------------------

  GameHost.prototype.tick = function () {
    const t = now();
    this.tickCount++;

    if (this.match.phase === 'intermission' && t >= this.match.endsAt) {
      if (this.humanCount() > 0) this.startMatch();
      else this.match.endsAt = t + this.config.INTERMISSION_MS;
    }
    if (this.match.phase === 'live' && t >= this.match.endsAt) {
      this.endMatch(this.match.scores.a === this.match.scores.b ? null
        : this.match.scores.a > this.match.scores.b ? 'a' : 'b');
    }

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.match.phase === 'live' && t >= p.respawnAt) {
          this.respawn(p);
          this.send(p.id, { type: 'respawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw, team: p.team });
        }
        continue;
      }

      if (p.reloadingUntil && t >= p.reloadingUntil) {
        p.reloadingUntil = 0;
        const w0 = WEAPONS[p.weapon], slot = p.loadout[p.weapon];
        const take = Math.min(w0.mag - slot.ammo, slot.reserve);
        slot.ammo += take;
        slot.reserve -= take;
        p.consecutive = 0;
        this.send(p.id, { type: 'ammo', ammo: slot.ammo, reserve: slot.reserve, reloaded: true });
      }

      // Spread recovers once you stop shooting. The client runs the identical
      // formula so the crosshair matches the cone actually used.
      const w = WEAPONS[p.weapon];
      if (p.consecutive > 0 && t - p.lastShotAt > SPREAD_RECOVER_DELAY_MS) {
        p.consecutive = Math.max(0, p.consecutive - w.spreadRecover * (this.tickMs / 1000) * 10);
      }

      // Refill the movement budget. Without this a client that simply sends
      // inputs faster than the tick rate would move faster than everyone else.
      p.budget = Math.min(0.25, p.budget + (this.tickMs / 1000) * 1.15);

      const queue = p.inputQueue;
      p.inputQueue = [];
      for (const input of queue) {
        if (input.seq <= p.lastSeq) continue;
        p.ads = !!input.ads;
        const allowed = Math.min(input.dt, Math.max(0, p.budget));
        p.budget -= input.dt;
        Shared.stepPlayer(p, input, allowed, w);
        p.onGround = p.y <= Shared.groundHeight(p.x, p.z, p.y) + 0.03;
        p.lastSeq = input.seq;
        if (input.shoot && this.match.phase === 'live') this.handleShot(p);
      }

      recordHistory(p, t);
    }

    if (this.tickCount % this.snapEvery === 0) this.sendSnapshot(t);
  };

  GameHost.prototype.snapshot = function (t) {
    const list = [];
    for (const p of this.players.values()) {
      list.push({
        id: p.id,
        x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
        yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
        c: p.crouch ? 1 : 0,
        sp: Math.round(Math.hypot(p.vx, p.vz) * 10) / 10,
        h: p.health, al: p.alive ? 1 : 0,
        w: p.weapon,
        pr: p.protectedUntil > now() ? 1 : 0,
        seq: p.lastSeq
      });
    }
    return { type: 'snapshot', t: t || now(), players: list };
  };

  GameHost.prototype.sendSnapshot = function (t) {
    const snap = this.snapshot(t);
    for (const p of this.players.values()) this.send(p.id, snap);
  };

  GameHost.prototype.pingAll = function () {
    const t = now();
    for (const p of this.players.values()) {
      if (!p.bot) this.send(p.id, { type: 'ping-request', t: t });
    }
  };

  exports.GameHost = GameHost;

})(
  typeof module !== 'undefined' && module.exports ? module.exports : (window.Game = {}),
  typeof module !== 'undefined' && module.exports ? require('./shared.js') : window.Shared
);
