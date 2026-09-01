# Arena

A browser team-deathmatch shooter. Two teams, five weapons, one 96-metre map. Players just open a link - no install, no plugin.

| File | What it is |
|---|---|
| `server.js` | The referee. Owns positions, damage, ammo and score. |
| `public/index.html` | The game. Rendering, input, prediction, HUD. |
| `public/shared.js` | Physics, map and weapon stats - loaded by both. |
| `test-*.js` | The test suite. `npm test` runs all of it. |
| `test-util.js` | A small navmesh and pathfinder the tests use to route bots. |

`shared.js` matters more than it looks. The server and the browser have to agree exactly on how movement works, or you rubber-band. One file, loaded in both places, means they cannot drift apart.

---

## Run it

Node 18 or newer.

```
npm install
npm start
```

Open http://localhost:3000. To test multiplayer alone, open a second window in incognito and join with a different name.

```
npm test        # everything
npm test core   # just one suite
```

---

## Controls

| Key | Action |
|---|---|
| WASD | Move |
| Shift | Sprint (cannot fire while sprinting) |
| Ctrl or C | Crouch - slower, smaller, more accurate |
| Space | Jump |
| Left click | Fire |
| Right click | Aim down sights |
| 1 - 5 | Switch weapon |
| R | Reload |
| Tab | Scoreboard |
| Esc | Release the mouse |

---

## Weapons

| Slot | Weapon | Role | Magazine | Notes |
|---|---|---|---|---|
| 1 | AR-15 | All-round | 30 | Automatic. Four body shots, one headshot at close range. |
| 2 | MP5-K | Close quarters | 30 | Fastest fire rate, damage drops off hard past 16m. |
| 3 | M40 Scout | Long range | 5 | One body shot kills. Slow, heavy, useless on the move. |
| 4 | M870 | Contact range | 7 | Nine pellets. Lethal under 7m, near-harmless past 25m. |
| 5 | P226 | Sidearm | 15 | Fast to draw, fastest to move with. |

Every weapon loses damage with distance, and every weapon has a different spread that grows while you hold the trigger. Aiming down sights tightens it, crouching tightens it, moving and jumping widen it. The crosshair shows the real cone the server is using - it is not decorative.

---

## Teams and matches

Two teams, Vanguard and Sable. **Teams are reshuffled at random at the start of every match**, so the same people are not stuck together forever. A match ends when one team reaches 40 kills or the 8-minute clock runs out; after a short break, teams are drawn again and a new match starts.

Friendly fire is off. You get 1.5 seconds of spawn protection, which you lose the moment you fire.

---

## The map

96 by 96 metres. A base at each end, a two-storey building in the middle that both teams want, climbable sniper towers on the flanks, and deliberately open ground down both sides so there is somewhere to actually sprint. The tests check there is at least a 30-metre unobstructed straight line - there is currently 89.

Steps and low crates can be walked up without jumping. Waist-high cover cannot, so you have to commit to a jump and be exposed while you do it.

The tests build a navmesh from the map and check that every walkable square is reachable from every spawn, then walk all 39 spawn-to-spawn routes with the real physics. That is what catches a corner where a player would wedge, or a staircase that cannot actually be climbed.

---

## Put it online

Render's free tier runs a real Node server, which is what WebSockets need. Static hosts like GitHub Pages or Netlify cannot do this.

1. Free GitHub account. Create a repository and upload these files - drag and drop on the website works, no git needed.
2. Free account at render.com.
3. **New** then **Web Service**, connect the repository.
4. Build command `npm install`, start command `npm start`, region nearest your players, instance type Free.
5. It gives you a URL like `arena-xyz.onrender.com`. Send it to your friends.

Nothing in the code needs changing - Render sets `PORT` and the server already reads it.

**The catch:** on the free tier the server sleeps after about 15 minutes idle, and the next person to open the link waits 30-50 seconds while it wakes. Open it a minute before everyone arrives. Paying (around $7/month) removes this. Check current pricing before committing.

A domain is optional and separate - it is just a name pointing at the server. Add it later without touching the game.

### Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 3000 | Set automatically by Render |
| `ARENA_MAX_PLAYERS` | 12 | Room size |
| `ARENA_SCORE_LIMIT` | 40 | Kills to win |
| `ARENA_ROUND_MS` | 480000 | Match length |
| `ARENA_INTERMISSION_MS` | 12000 | Break between matches |

`GET /health` returns player count and match phase, useful for uptime monitors.

---

## How the networking works

**The server is the referee.** Your browser never says "I am at x=5" or "I killed Bob". It says "I am holding W" and "I clicked at this angle". The server works out the rest. Editing the page gets you nothing, because lying about your inputs does not help.

**Prediction.** Waiting for a reply before you move would feel like walking through syrup, so the browser runs the same physics locally and moves you immediately. When the server's version arrives, the browser snaps to it and replays whatever you have done since. The soak test measures how far apart the two get: about 1mm on average.

**Interpolation.** Snapshots arrive 22 times a second. Drawing them raw would make everyone teleport, so other players are rendered 100ms in the past, sliding between two snapshots the browser already holds.

**Lag compensation.** When you fire, the server rewinds every other player to where they were on your screen when you pulled the trigger - about half your ping plus that 100ms. Without it you would have to lead every shot by your own latency.

---

## Tuning

Everything is at the top of `public/shared.js`. Change a number, restart, feel the difference.

- `BASE_SPEED`, `SPRINT_MUL`, `CROUCH_MUL` - how movement feels
- `STEP_HEIGHT` - how tall a ledge you can walk up without jumping
- `INTERP_MS` - lower is more responsive, jerkier on a bad connection
- The `WEAPONS` table - damage, spread, recoil, reload, falloff, all of it

The map is a list of boxes further down the same file, with helpers for buildings, stairs and towers. Add one and it appears in the game, blocks bullets, and casts a shadow automatically. The server sends the map to every browser on join, so there is only ever one copy to edit.

---

## What the tests cover

`npm test` runs 119 checks across five suites.

- **Core** - map integrity and connectivity, no spawn inside a wall, open ground to sprint, all 39 spawn-to-spawn routes walked with real physics, gravity, sprint/crouch/ADS speeds, walls, stairs, escape attempts, determinism, weapon balance, spread behaviour, hit zones, damage falloff, cover
- **Network** - joining, team balance, base spawns, weapon switching, reload, dry magazines, server-enforced fire rate, input flooding, malformed messages, room capacity
- **Combat** - two bots pathfind to a computed duelling ground, then damage over the wire, hitmarkers, kill events, respawn, friendly fire staying off
- **Teams** - 4000 shuffles checked for balance, variety and bias, plus a live match ending and restarting with new teams
- **Soak** - six bots moving and firing for nine seconds, watching snapshot rate, prediction drift, and whether anyone ends up stuck inside geometry

---

## What this is not

Basic anti-cheat only. The server owns every outcome, clamps impossible timesteps, enforces rate of fire, and gives each client a movement budget that refills at real time - so flooding inputs buys no extra speed. There is no anti-cheat client, no signed builds, nothing stopping an aimbot that only reads the screen.

No sound. No matchmaking or lobbies - everyone on the link is in the same match. No mobile support; it needs a mouse.

Two spawn points inside the base buildings are almost impossible to see into from open ground. Good for the person spawning, awkward if you want a fast fight. Worth widening the doorways if that grates.
