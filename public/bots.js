// bots.js
// Bot players for a capture-the-flag match. They are ordinary players to the
// simulation - they send the same input messages a browser does, so anything
// the server refuses a human it refuses a bot. Difficulty changes reaction and
// aim, never health or damage.
//
// Each bot picks a role - fetch the enemy flag, or defend our own - and
// navigates with the shared navmesh. In a fight it swaps to whatever the
// situation wants: swing if the enemy is close, loose arrows if they are far.

(function (exports, Shared, Nav) {
  'use strict';

  const { CONFIG, WEAPONS, WEAPON_BY_ID, MAP } = Shared;

  const SKILLS = {
    recruit: { reaction: 600, aimError: 0.09, turnRate: 3.2, keepRange: 10 },
    regular: { reaction: 360, aimError: 0.045, turnRate: 5.2, keepRange: 14 },
    veteran: { reaction: 200, aimError: 0.02, turnRate: 7.6, keepRange: 18 }
  };

  const NAMES = ['Aldric', 'Bryn', 'Cedric', 'Dunstan', 'Edmund', 'Godfrey',
                 'Hale', 'Ivo', 'Roland', 'Tybalt', 'Wat', 'Osric'];

  const now = () => Date.now();
  const rand = (a, b) => a + Math.random() * (b - a);

  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function spawnBots(host, count, skillName, opts) {
    opts = opts || {};
    const skill = SKILLS[skillName] || SKILLS.regular;
    const pool = NAMES.slice().sort(() => Math.random() - 0.5);
    const looks = host.constructor && exports._looks ? exports._looks : null;
    const made = [];
    for (let i = 0; i < count; i++) {
      const joined = host.join(pool[i % pool.length] || ('bot' + i), {
        bot: true, team: opts.team,
        look: {
          body: ['body_light', 'body_brown', 'body_dark'][i % 3],
          torso: ['torso_chain', 'torso_plate', 'torso_leather'][i % 3],
          hair: ['hair_messy', 'hair_long', 'hair_bald'][i % 3]
        }
      });
      if (!joined) break;
      made.push({
        id: joined.id, seq: 0, skillName: skillName || 'regular', skill: skill,
        role: i % 2 === 0 ? 'attack' : 'defend',
        path: null, pathIdx: 0, repathAt: 0, dest: null,
        targetId: null, sawAt: 0, nextScan: 0,
        strafe: Math.random() < 0.5 ? 1 : -1, strafeUntil: 0,
        stuck: 0, lastPos: { x: 0, z: 0 }, jumpAt: 0
      });
    }
    return made;
  }

  function canSee(me, them) {
    const d = Shared.dims(me.crouch);
    const ex = me.x, ey = me.y + d.eye, ez = me.z;
    const td = Shared.dims(them.crouch);
    const dx = them.x - ex, dy = (them.y + td.h * 0.55) - ey, dz = them.z - ez;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.01) return dist;
    const wall = Shared.rayWall(ex, ey, ez, dx / dist, dy / dist, dz / dist, dist + 1);
    return wall.t >= dist - 0.2 ? dist : -1;
  }

  function pickTarget(host, bot, me, t) {
    if (bot.targetId) {
      const cur = host.players.get(bot.targetId);
      if (cur && cur.alive && cur.team !== me.team) {
        const d = canSee(me, cur);
        if (d >= 0) return { p: cur, dist: d };
      }
      bot.targetId = null;
    }
    if (t < bot.nextScan) return null;
    bot.nextScan = t + 160;
    let best = null, bestD = Infinity;
    for (const q of host.players.values()) {
      if (!q.alive || q.team === me.team || q.id === me.id) continue;
      const d = canSee(me, q);
      if (d >= 0 && d < bestD) { bestD = d; best = q; }
    }
    if (best) { bot.targetId = best.id; bot.sawAt = t; return { p: best, dist: bestD }; }
    return null;
  }

  function repath(bot, me, dest) {
    bot.path = Nav.findPath({ x: me.x, z: me.z }, dest);
    bot.pathIdx = 1; bot.dest = dest; bot.repathAt = now() + 2000;
    return !!bot.path;
  }

  // Where should this bot be going right now, given its role and the flags?
  function objective(host, bot, me) {
    const myFlag = host.flags[me.team];
    const enemyFlag = host.flags[me.team === 'a' ? 'b' : 'a'];

    if (me.carrying) return { x: MAP.flags[me.team].x, z: MAP.flags[me.team].z };  // run home

    // If our flag is out, everyone nearby helps get it back
    if (myFlag.state !== 'home') {
      const d = Math.hypot(me.x - myFlag.x, me.z - myFlag.z);
      if (bot.role === 'defend' || d < 40) return { x: myFlag.x, z: myFlag.z };
    }

    if (bot.role === 'attack') return { x: enemyFlag.x, z: enemyFlag.z };

    // Defender: sit near our flag, or grab a weapon if still on fists
    if (me.weapon === Shared.FISTS) {
      const ped = nearestReadyPedestal(host, me);
      if (ped) return { x: ped.x, z: ped.z };
    }
    return { x: myFlag.x + rand(-6, 6), z: myFlag.z + rand(-6, 6) };
  }

  function nearestReadyPedestal(host, me) {
    let best = null, bestD = Infinity;
    for (const ped of host.pedestals) {
      if (!ped.ready) continue;
      const d = Math.hypot(me.x - ped.x, me.z - ped.z);
      if (d < bestD) { bestD = d; best = ped; }
    }
    return best;
  }

  function think(host, bot, dt) {
    const me = host.players.get(bot.id);
    if (!me) return null;
    const t = now();
    if (!me.alive) { bot.path = null; bot.targetId = null; return null; }

    const w = WEAPONS[me.weapon];
    const skill = bot.skill;
    let desiredYaw = me.yaw, desiredPitch = me.pitch;
    let forward = 0, right = 0, sprint = false, attack = false, block = false, use = false, jumpEdge = false;

    // Grab a weapon or medkit we are standing on
    for (const ped of host.pedestals) {
      if (ped.ready && me.weapon === Shared.FISTS &&
          Math.hypot(me.x - ped.x, me.z - ped.z) < CONFIG.PICKUP_RANGE) { use = true; }
    }

    const seen = pickTarget(host, bot, me, t);
    const reacted = seen && (t - bot.sawAt) >= skill.reaction;

    if (seen && !reacted) {
      // Target spotted but the reaction delay has not elapsed - hold still and
      // keep the lock so sawAt is not reset next tick. Turn to face them.
      const dx = seen.p.x - me.x, dz = seen.p.z - me.z;
      desiredYaw = Math.atan2(-dx, -dz);
      bot.path = null;
    } else if (reacted) {
      const d = Shared.dims(me.crouch), td = Shared.dims(seen.p.crouch);
      const dx = seen.p.x - me.x, dy = (seen.p.y + td.h * 0.6) - (me.y + d.eye), dz = seen.p.z - me.z;
      const flat = Math.hypot(dx, dz);
      desiredYaw = Math.atan2(-dx, -dz);
      desiredPitch = Math.atan2(dy, flat);

      const aimOff = Math.abs(angleDiff(desiredYaw, me.yaw));
      const onTarget = aimOff < 0.12 + (1 - 1 / (skill.turnRate)) * 0.1;

      if (w.kind === 'ranged') {
        // Arrows drop, so aim a little high at range
        desiredPitch += Math.min(0.25, flat / 260);
        if (flat > seen.dist * 0.5) forward = flat > 22 ? 1 : 0;
        if (t > bot.strafeUntil) { bot.strafe = -bot.strafe; bot.strafeUntil = t + rand(700, 1500); }
        right = bot.strafe * 0.6;
        if (onTarget && t >= me.nextAttackAt) attack = true;
      } else {
        // Melee: close, then swing in reach. Block if they are winding up.
        if (seen.dist > w.reach - 0.3) { forward = 1; sprint = seen.dist > 8; }
        else {
          if (seen.p.pendingSwing || seen.p.wu) block = Math.random() < 0.5;
          if (onTarget && t >= me.nextAttackAt && !block) attack = true;
          if (t > bot.strafeUntil) { bot.strafe = -bot.strafe; bot.strafeUntil = t + rand(400, 900); }
          right = bot.strafe;
        }
      }
      bot.path = null;
    } else {
      // No target: pursue the objective
      bot.targetId = null;
      const dest = objective(host, bot, me);
      const dd = Math.hypot(me.x - dest.x, me.z - dest.z);
      if (dd > 2.5) {
        if (!bot.path || t > bot.repathAt || bot.pathIdx >= (bot.path ? bot.path.length : 0) ||
            !bot.dest || Math.hypot(bot.dest.x - dest.x, bot.dest.z - dest.z) > 4) {
          repath(bot, me, dest);
        }
        if (bot.path) {
          let wp = bot.path[bot.pathIdx];
          let gap = wp ? Math.hypot(wp.x - me.x, wp.z - me.z) : 0;
          while (wp && gap < 0.9 && bot.pathIdx < bot.path.length - 1) {
            bot.pathIdx++; wp = bot.path[bot.pathIdx]; gap = Math.hypot(wp.x - me.x, wp.z - me.z);
          }
          if (wp) { desiredYaw = Math.atan2(-(wp.x - me.x), -(wp.z - me.z)); forward = 1; sprint = gap > 6 && !me.carrying; }
        }
      }
    }

    // Turn toward the goal at a human rate
    const turn = skill.turnRate * dt;
    let yaw = me.yaw + Math.max(-turn, Math.min(turn, angleDiff(desiredYaw, me.yaw)));
    let pitch = me.pitch + Math.max(-turn, Math.min(turn, desiredPitch - me.pitch));
    if (seen) { yaw += (Math.random() - 0.5) * skill.aimError; pitch += (Math.random() - 0.5) * skill.aimError * 0.6; }
    pitch = Math.max(-1.4, Math.min(1.4, pitch));

    // Unstick
    const moved = Math.hypot(me.x - bot.lastPos.x, me.z - bot.lastPos.z);
    bot.lastPos = { x: me.x, z: me.z };
    if (forward !== 0 && moved < 0.012) {
      bot.stuck++;
      if (bot.stuck > 18) { right = bot.strafe; yaw += 0.6; }
      if (bot.stuck > 40) { jumpEdge = true; bot.path = null; bot.repathAt = 0; bot.stuck = 0; }
    } else bot.stuck = 0;

    return {
      type: 'input', seq: ++bot.seq, dt: dt,
      forward: forward, right: right, jumpEdge: jumpEdge,
      crouch: false, sprint: sprint && forward > 0,
      attack: attack, block: block, use: use,
      yaw: yaw, pitch: pitch
    };
  }

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
