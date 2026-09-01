// bots.js
// Bot opponents. They are ordinary players as far as game.js is concerned -
// they send the same input messages a browser does, and the simulation has no
// idea they are not human. That means anything a bot can do, a player can, and
// anything the server refuses a player it refuses a bot.
//
// Used by offline mode, and by the server when ARENA_BOTS is set.

(function (exports, Shared, Nav) {
  'use strict';

  const { CONFIG, WEAPONS } = Shared;

  // ------------------------------------------------------------------
  // Skill levels. The difference is reaction time and how badly they aim,
  // not extra health or damage - a bot that cheats is not fun to beat.
  // ------------------------------------------------------------------
  const SKILLS = {
    recruit:  { reaction: 620, aimError: 0.075, turnRate: 3.2, burst: [3, 7],  keepDist: 14, accuracy: 0.55 },
    regular:  { reaction: 380, aimError: 0.038, turnRate: 5.0, burst: [4, 9],  keepDist: 16, accuracy: 0.75 },
    veteran:  { reaction: 210, aimError: 0.018, turnRate: 7.5, burst: [5, 12], keepDist: 18, accuracy: 0.9 }
  };

  const NAMES = [
    'Vasquez', 'Renner', 'Okonkwo', 'Salt', 'Brandt', 'Ito', 'Kowal', 'Petrov',
    'Nadeau', 'Marsh', 'Dunne', 'Ferro', 'Halvorsen', 'Rask', 'Oyelaran', 'Byrne'
  ];

  const now = () => Date.now();
  const rand = (a, b) => a + Math.random() * (b - a);

  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // ------------------------------------------------------------------
  // Creating bots
  // ------------------------------------------------------------------

  function spawnBots(host, count, skillName, opts) {
    opts = opts || {};
    const skill = SKILLS[skillName] || SKILLS.regular;
    const pool = NAMES.slice().sort(() => Math.random() - 0.5);
    const made = [];

    for (let i = 0; i < count; i++) {
      // A spread of weapons so the fights are varied
      const weapon = [0, 0, 1, 4, 3, 2][i % 6];
      const joined = host.join(pool[i % pool.length] || ('bot' + i), {
        bot: true,
        weapon: weapon,
        team: opts.team
      });
      if (!joined) break;

      made.push({
        id: joined.id,
        seq: 0,
        skillName: skillName || 'regular',
        skill: skill,
        path: null,
        pathIdx: 0,
        repathAt: 0,
        destination: null,
        targetId: null,
        sawTargetAt: 0,
        firingUntil: 0,
        pauseUntil: 0,
        stuckTicks: 0,
        lastPos: { x: 0, z: 0 },
        strafe: Math.random() < 0.5 ? 1 : -1,
        strafeUntil: 0,
        jumpAt: 0,
        nextScanAt: 0
      });
    }
    return made;
  }

  // ------------------------------------------------------------------
  // Perception
  // ------------------------------------------------------------------

  function canSee(host, me, them) {
    const d = Shared.dims(me.crouch);
    const ex = me.x, ey = me.y + d.eye, ez = me.z;
    const td = Shared.dims(them.crouch);
    const tx = them.x, ty = them.y + td.h * 0.55, tz = them.z;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.01) return dist;
    const wall = Shared.rayWall(ex, ey, ez, dx / dist, dy / dist, dz / dist, dist + 1);
    return wall.t >= dist - 0.2 ? dist : -1;
  }

  // Checking line of sight to everyone, every tick, for every bot is the most
  // expensive thing here - and it all runs inside one browser tab in offline
  // mode. So re-verify the current target every tick (one ray), but only sweep
  // for a new one a few times a second.
  function pickTarget(host, bot, me, t) {
    if (bot.targetId) {
      const cur = host.players.get(bot.targetId);
      if (cur && cur.alive && cur.team !== me.team) {
        const d = canSee(host, me, cur);
        if (d >= 0) return { player: cur, dist: d };
      }
      bot.targetId = null;
    }
    if (t < bot.nextScanAt) return null;
    bot.nextScanAt = t + 140;

    let best = null, bestDist = Infinity;
    for (const other of host.players.values()) {
      if (!other.alive || other.team === me.team || other.id === me.id) continue;
      const dist = canSee(host, me, other);
      if (dist < 0) continue;
      if (dist < bestDist) { bestDist = dist; best = other; }
    }
    return best ? { player: best, dist: bestDist } : null;
  }

  // ------------------------------------------------------------------
  // Movement
  // ------------------------------------------------------------------

  function repath(bot, me, dest) {
    const path = Nav.findPath({ x: me.x, z: me.z }, dest);
    bot.path = path;
    bot.pathIdx = 1;
    bot.destination = dest;
    bot.repathAt = now() + 2500;
    return !!path;
  }

  // Somewhere worth going when there is nobody to shoot at
  function wanderTarget(host, me) {
    let nearestEnemy = null, best = Infinity;
    for (const other of host.players.values()) {
      if (!other.alive || other.team === me.team) continue;
      const d = Math.hypot(other.x - me.x, other.z - me.z);
      if (d < best) { best = d; nearestEnemy = other; }
    }
    if (nearestEnemy && Math.random() < 0.75) {
      return { x: nearestEnemy.x, z: nearestEnemy.z };
    }
    const cells = Nav.allWalkableCells();
    return cells[Math.floor(Math.random() * cells.length)];
  }

  // Steer along the current path. Returns { forward, right, yaw } or null.
  function followPath(bot, me) {
    if (!bot.path || bot.pathIdx >= bot.path.length) return null;

    let t = bot.path[bot.pathIdx];
    let gap = Math.hypot(t.x - me.x, t.z - me.z);

    // Waypoints are a metre apart, so the tolerance has to be tighter than
    // that or the bot skips one and walks at a wall.
    while (gap < 0.9 && bot.pathIdx < bot.path.length - 1) {
      bot.pathIdx++;
      t = bot.path[bot.pathIdx];
      gap = Math.hypot(t.x - me.x, t.z - me.z);
    }
    if (gap < 0.9) { bot.path = null; return null; }

    return { yaw: Math.atan2(-(t.x - me.x), -(t.z - me.z)), gap: gap };
  }

  // ------------------------------------------------------------------
  // One decision, once per tick, per bot
  // ------------------------------------------------------------------

  function think(host, bot, dt) {
    const me = host.players.get(bot.id);
    if (!me) return null;

    const t = now();

    if (!me.alive) {
      bot.path = null;
      bot.targetId = null;
      return null;
    }

    const w = WEAPONS[me.weapon];
    const slot = me.loadout[me.weapon];
    const skill = bot.skill;

    // Reload when empty, or when there is a lull and the magazine is low
    if (slot.ammo === 0 && slot.reserve > 0 && !me.reloadingUntil) {
      host.handle(bot.id, { type: 'reload' });
    }

    const seen = pickTarget(host, bot, me, t);
    let desiredYaw = me.yaw, desiredPitch = me.pitch;
    let forward = 0, right = 0, sprint = false, crouch = false, ads = false, shoot = false, jump = false;

    if (seen) {
      // First sighting starts a reaction clock - bots should not be instant
      if (bot.targetId !== seen.player.id) {
        bot.targetId = seen.player.id;
        bot.sawTargetAt = t;
      }
      const reacted = (t - bot.sawTargetAt) >= skill.reaction;

      const d = Shared.dims(me.crouch);
      const td = Shared.dims(seen.player.crouch);
      const dx = seen.player.x - me.x;
      const dy = (seen.player.y + td.h * 0.6) - (me.y + d.eye);
      const dz = seen.player.z - me.z;
      const flat = Math.hypot(dx, dz);

      desiredYaw = Math.atan2(-dx, -dz);
      desiredPitch = Math.atan2(dy, flat);

      // Lead a moving target a little, badly, in proportion to skill
      const lead = skill.accuracy * 0.12;
      desiredYaw += -(seen.player.vx * Math.cos(desiredYaw) + seen.player.vz * Math.sin(desiredYaw)) * lead * 0.02;

      if (reacted) {
        ads = seen.dist > 12 && w.id !== 'shotgun';

        // Hold position at a sensible range for the weapon in hand
        const ideal = w.id === 'shotgun' ? 6 : w.id === 'dmr' ? 45 : skill.keepDist;
        if (seen.dist > ideal * 1.35) { forward = 1; sprint = seen.dist > 40; }
        else if (seen.dist < ideal * 0.55) forward = -1;

        // Strafe so they are not a stationary target
        if (t > bot.strafeUntil) {
          bot.strafe = -bot.strafe;
          bot.strafeUntil = t + rand(500, 1400);
        }
        right = bot.strafe * (seen.dist < 30 ? 1 : 0.5);

        if (seen.dist > 30 && Math.random() < 0.01) crouch = true;

        // Fire in bursts, only when actually pointing at them
        const aimOff = Math.abs(angleDiff(desiredYaw, me.yaw)) + Math.abs(desiredPitch - me.pitch);
        const onTarget = aimOff < 0.045 + (1 - skill.accuracy) * 0.05;
        const inRange = seen.dist < w.range * 0.8;

        if (onTarget && inRange && slot.ammo > 0 && t > bot.pauseUntil) {
          shoot = true;
          if (t > bot.firingUntil) {
            // start a new burst
            bot.firingUntil = t + rand(skill.burst[0], skill.burst[1]) * w.fireMs;
          }
          if (t > bot.firingUntil) {
            bot.pauseUntil = t + rand(180, 520);      // let the spread settle
            bot.firingUntil = 0;
            shoot = false;
          }
        }
      } else {
        // Still reacting - turn toward them but hold fire
        forward = 0;
      }

      bot.path = null;    // fighting takes priority over the route

    } else {
      // Nothing in sight: go somewhere
      bot.targetId = null;
      if (!bot.path || t > bot.repathAt || bot.pathIdx >= (bot.path ? bot.path.length : 0)) {
        repath(bot, me, wanderTarget(host, me));
      }
      const steer = followPath(bot, me);
      if (steer) {
        desiredYaw = steer.yaw;
        desiredPitch = 0;
        forward = 1;
        sprint = steer.gap > 6;
      } else {
        bot.path = null;
      }
    }

    // Turn toward where we want to look, at a human-ish rate
    const turn = skill.turnRate * dt;
    const dYaw = angleDiff(desiredYaw, me.yaw);
    const dPitch = desiredPitch - me.pitch;
    let yaw = me.yaw + Math.max(-turn, Math.min(turn, dYaw));
    let pitch = me.pitch + Math.max(-turn, Math.min(turn, dPitch));

    // Aim is never perfect
    if (seen) {
      yaw += (Math.random() - 0.5) * skill.aimError;
      pitch += (Math.random() - 0.5) * skill.aimError * 0.6;
    }
    pitch = Math.max(-1.4, Math.min(1.4, pitch));

    // Unstick: if we have not moved but wanted to, try something else
    const moved = Math.hypot(me.x - bot.lastPos.x, me.z - bot.lastPos.z);
    bot.lastPos = { x: me.x, z: me.z };
    if (forward !== 0 && moved < 0.01) {
      bot.stuckTicks++;
      if (bot.stuckTicks > 20) {
        right = bot.strafe;
        yaw += 0.7;
        if (bot.stuckTicks > 45) { jump = true; bot.path = null; bot.repathAt = 0; bot.stuckTicks = 0; }
      }
    } else {
      bot.stuckTicks = 0;
    }

    return {
      type: 'input', seq: ++bot.seq, dt: dt,
      forward: forward, right: right,
      jump: jump, crouch: crouch, sprint: sprint && forward > 0,
      ads: ads, shoot: shoot,
      yaw: yaw, pitch: pitch
    };
  }

  // Called once per tick with the elapsed time
  function driveBots(host, bots, dt) {
    for (const bot of bots) {
      const input = think(host, bot, dt);
      if (input) host.handle(bot.id, input);
    }
  }

  exports.SKILLS = SKILLS;
  exports.spawnBots = spawnBots;
  exports.driveBots = driveBots;
  exports.think = think;
  exports.canSee = canSee;

})(
  typeof module !== 'undefined' && module.exports ? module.exports : (window.Bots = {}),
  typeof module !== 'undefined' && module.exports ? require('./shared.js') : window.Shared,
  typeof module !== 'undefined' && module.exports ? require('./nav.js') : window.Nav
);
