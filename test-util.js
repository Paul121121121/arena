// Test helpers shared by the suites.
//
// A tiny ground-level navmesh over the map, so tests can route a bot from A
// to B instead of hoping it wanders somewhere useful. The same grid is used
// to assert the map is actually connected - that no part of it is walled off.
const S = require('./public/shared.js');
const { MAP, CONFIG } = S;

// A 1-metre grid. At 2m a thin wall could sit entirely between two cell
// centres, letting a route slip straight through it.
const CELL = 1;
const LIMIT = MAP.size / 2 - 2;

// Is a player standing here blocked at ground level?
// Elevated pieces (roofs, platforms) sit above the ground so they do not
// block it; anything low enough to step over does not block it either.
function blockedAt(x, z) {
  const r = CONFIG.PLAYER_RADIUS;
  for (let i = 0; i < MAP.boxes.length; i++) {
    const b = MAP.boxes[i];
    if (b.y > 0.01) continue;                        // elevated: sits above ground level
    if (b.y + b.h <= CONFIG.STEP_HEIGHT) continue;   // low enough to step over
    // Staircases count as blocked here. A player can walk up them, but only
    // from the low end - approach one side-on and it is a wall. Routing around
    // them is the conservative choice; climbing them has its own test.
    if (x > b.x - b.w / 2 - r && x < b.x + b.w / 2 + r &&
        z > b.z - b.d / 2 - r && z < b.z + b.d / 2 + r) return true;
  }
  return false;
}

const key = (i, j) => i + ',' + j;
const toCell = v => Math.round((v + LIMIT) / CELL);
const toWorld = c => c * CELL - LIMIT;
const SPAN = Math.round((LIMIT * 2) / CELL);

// Work the whole grid out once - blockedAt is called a lot otherwise.
let GRID = null;
function grid() {
  if (GRID) return GRID;
  GRID = new Uint8Array((SPAN + 1) * (SPAN + 1));
  for (let i = 0; i <= SPAN; i++) {
    for (let j = 0; j <= SPAN; j++) {
      GRID[i * (SPAN + 1) + j] = blockedAt(toWorld(i), toWorld(j)) ? 0 : 1;
    }
  }
  return GRID;
}

function walkableCell(i, j) {
  if (i < 0 || j < 0 || i > SPAN || j > SPAN) return false;
  return grid()[i * (SPAN + 1) + j] === 1;
}

// Breadth-first search across the walkable grid. Returns world-space waypoints.
// If a point sits in a blocked cell (pressed against a wall, say), start from
// the nearest free cell instead of giving up.
function nearestWalkable(i, j) {
  if (walkableCell(i, j)) return [i, j];
  for (let ring = 1; ring <= 4; ring++) {
    for (let di = -ring; di <= ring; di++) {
      for (let dj = -ring; dj <= ring; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
        if (walkableCell(i + di, j + dj)) return [i + di, j + dj];
      }
    }
  }
  return null;
}

function findPath(from, to) {
  const start = nearestWalkable(toCell(from.x), toCell(from.z));
  const goal = nearestWalkable(toCell(to.x), toCell(to.z));
  if (!start || !goal) return null;

  const prev = new Map();
  const seen = new Set([key(start[0], start[1])]);
  let queue = [start];

  while (queue.length) {
    const next = [];
    for (const [i, j] of queue) {
      if (i === goal[0] && j === goal[1]) {
        const path = [];
        let cur = key(i, j);
        while (cur) {
          const [ci, cj] = cur.split(',').map(Number);
          path.unshift({ x: toWorld(ci), z: toWorld(cj) });
          cur = prev.get(cur);
        }
        return smoothPath(path);
      }
      const around = [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1],
                      [i + 1, j + 1], [i - 1, j - 1], [i + 1, j - 1], [i - 1, j + 1]];
      for (const [ni, nj] of around) {
        const k = key(ni, nj);
        if (seen.has(k) || !walkableCell(ni, nj)) continue;
        // Do not cut diagonally past a corner - the collision system will not
        // let a player squeeze through there, so the path would stall.
        if (ni !== i && nj !== j &&
            (!walkableCell(ni, j) || !walkableCell(i, nj))) continue;
        seen.add(k);
        prev.set(k, key(i, j));
        next.push([ni, nj]);
      }
    }
    queue = next;
  }
  return null;
}

// Can a player walk the straight line between two points without snagging?
// Sampled along the segment, with lateral offsets for the player's width.
function straightWalkClear(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.01) return true;
  const ux = dx / dist, uz = dz / dist;
  const px = -uz, pz = ux;                      // perpendicular, for width
  const steps = Math.ceil(dist / 0.35);
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * dist;
    for (const off of [0, 0.3, -0.3]) {
      if (blockedAt(a.x + ux * t + px * off, a.z + uz * t + pz * off)) return false;
    }
  }
  return true;
}

// Grid paths come out as staircases. Pull the string taut so the bot runs in
// straight lines instead of zig-zagging through every cell.
function smoothPath(path) {
  if (!path || path.length < 3) return path;
  const MAX_SEGMENT = 10;   // keep waypoints close enough that small drift
                            // cannot swing the line into a corner
  const out = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let best = i + 1;
    for (let j = path.length - 1; j > i + 1; j--) {
      const span = Math.hypot(path[j].x - path[i].x, path[j].z - path[i].z);
      if (span > MAX_SEGMENT) continue;
      if (straightWalkClear(path[i], path[j])) { best = j; break; }
    }
    out.push(path[best]);
    i = best;
  }
  return out;
}

// Every walkable cell reachable from a starting point
function reachableFrom(from) {
  const start = [toCell(from.x), toCell(from.z)];
  if (!walkableCell(start[0], start[1])) return new Set();
  const seen = new Set([key(start[0], start[1])]);
  let queue = [start];
  while (queue.length) {
    const next = [];
    for (const [i, j] of queue) {
      for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        const k = key(ni, nj);
        if (seen.has(k) || !walkableCell(ni, nj)) continue;
        seen.add(k);
        next.push([ni, nj]);
      }
    }
    queue = next;
  }
  return seen;
}

function allWalkableCells() {
  const out = [];
  for (let i = 0; i <= SPAN; i++) {
    for (let j = 0; j <= SPAN; j++) {
      if (walkableCell(i, j)) out.push({ x: toWorld(i), z: toWorld(j) });
    }
  }
  return out;
}

// Can a player standing at `from` see a player standing at `to`?
function hasLineOfSight(from, to) {
  const ex = from.x, ey = (from.y || 0) + CONFIG.STAND_EYE, ez = from.z;
  const tx = to.x, ty = (to.y || 0) + 1.0, tz = to.z;
  const dx = tx - ex, dy = ty - ey, dz = tz - ez;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.001) return true;
  const w = S.rayWall(ex, ey, ez, dx / dist, dy / dist, dz / dist, dist + 1);
  return w.t >= dist - 0.1;
}

// Find a walkable spot with a clear shot at `target`, as close to `from` as
// possible while staying within a sensible engagement range.
// A bot will not stop exactly on the mark, so only accept a spot whose
// sightline survives being a metre or two off in any direction.
function robustLineOfSight(c, target, slack) {
  const offsets = [[0, 0], [slack, 0], [-slack, 0], [0, slack], [0, -slack]];
  return offsets.every(o => hasLineOfSight({ x: c.x + o[0], z: c.z + o[1] }, target));
}

function findFiringPosition(from, target, minRange, maxRange, slack) {
  let best = null, bestCost = Infinity;
  for (const c of allWalkableCells()) {
    const d = Math.hypot(c.x - target.x, c.z - target.z);
    if (d < minRange || d > maxRange) continue;
    if (!robustLineOfSight(c, target, slack === undefined ? 2.2 : slack)) continue;
    const cost = Math.hypot(c.x - from.x, c.z - from.z);
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return best;
}

// Pick somewhere the two bots can actually fight: an open spot the target can
// reach, plus a spot with a clear shot at it that the shooter can reach.
// Validating the pair together matters - plenty of cells look open but sit in
// a corner nothing can see into.
function stageDuel(shooterPos, targetPos, opts) {
  const o = opts || {};
  const maxWalk = o.maxWalk || 50;
  const minRange = o.minRange || 22;
  const maxRange = o.maxRange || 45;
  const slack = o.slack === undefined ? 2.5 : o.slack;

  const candidates = allWalkableCells()
    .filter(c => Math.abs(c.x) >= 28)                     // the open flank lanes
    .map(c => ({ c: c, cost: Math.hypot(c.x - targetPos.x, c.z - targetPos.z) }))
    .filter(e => e.cost <= maxWalk)
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 14);

  for (const e of candidates) {
    const shot = findFiringPosition(shooterPos, { x: e.c.x, y: 0, z: e.c.z },
      minRange, maxRange, slack);
    if (shot) return { targetSpot: e.c, shooterSpot: shot };
  }
  return null;
}

module.exports = {
  CELL, blockedAt, findPath, smoothPath, straightWalkClear, reachableFrom, allWalkableCells,
  hasLineOfSight, robustLineOfSight, findFiringPosition, stageDuel
};
