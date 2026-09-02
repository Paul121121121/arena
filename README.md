# Castle Clash

A browser-based, first-person, pixel-art **capture-the-flag** game for up to 6
players (3v3). Medieval castles, timing-based melee, bows and crossbows, and an
authoritative Node server with client-side prediction. Play online against
other people, or offline against bots.

The look and feel take after games like **Mordhau** and **Decrepit**: your
weapon is held in view, melee swings have a wind-up you can read and block, and
the world is dark stone and timber.

![gameplay is first-person; other players are pixel sprite billboards]

---

## How to play

- **WASD** - move
- **Space** - jump (press again in the air to **double jump**)
- **Shift** - sprint
- **Ctrl** or **C** - crouch
- **Left-click** - attack (melee swing / loose an arrow)
- **Right-click** - block (melee only; drains stamina, cuts incoming damage)
- **E** - take the weapon off a pedestal you are standing on
- **Tab** - hold to see the scoreboard
- **Mouse** - look

### The goal

Take the **enemy flag** from their keep, carry it back to **your** flag stand,
and touch your stand to score. Classic rule: **your own flag must be home** for
a capture to count, so defending matters as much as attacking. First team to
**5 captures** (configurable) wins the match. Teams reshuffle every match.

### Fighting

- Everyone spawns with **fists** only. Better weapons sit on **pedestals**
  around the map - walk up and press **E** to swap.
- **Melee** (sword, axe, spear): each swing has a wind-up. A blocking, facing
  defender turns most of it aside - so feint, flank, or break their stamina.
- **Ranged** (bow, crossbow): infinite ammo, but arrows drop over distance and
  the crossbow reloads slowly. Lead your shots.
- **Medkits** appear around the map; walk over one to heal. They relocate after
  use.
- Wounds show on your character as you take damage. Die, and you respawn at your
  keep with fists again.

### Sound

Footsteps, jumps, melee swings, arrow and bolt release, blocks, weapon pickups,
healing, deaths, flag events and captures all have sound effects, positioned in
the world (a fight across the map sounds far away and off to the side). Menu and
battle music play in the background, with a different battle track each match.

Browsers block audio until you interact with the page, so sound starts on your
first click or key. Toggle it any time with the **sound** control in the
top-left of the HUD.

---

## Running it

Requires **Node 18+**.

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

To develop with a longer round timer and bots already in the server:

```bash
npm run dev
```

### Configuration (environment variables)

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | HTTP/WebSocket port | 3000 |
| `ARENA_BOTS` | Bots to add to the server on boot | 0 |
| `ARENA_BOT_SKILL` | `recruit`, `regular`, or `veteran` | regular |
| `ARENA_CAPTURES` | Captures to win a match | 5 |
| `ARENA_ROUND_MS` | Round time limit in ms | (see shared.js) |
| `ARENA_INTERMISSION_MS` | Break between matches in ms | (see shared.js) |
| `ARENA_MAX_PLAYERS` | Player cap | 6 |

---

## Deploying

This is a **real-time WebSocket server**, so it needs a host that runs Node
processes - not a static host (GitHub Pages, Netlify, and plain S3 cannot do
multiplayer). Any of Render, Railway, Fly.io, or a VPS works.

**Render (free tier):**
1. Push this folder to a Git repo.
2. New > Web Service, point it at the repo.
3. Build command `npm install`, start command `npm start`.
4. Free instances sleep after ~15 min idle; the first visitor waits ~30-50s for
   a cold start, then it's responsive.

The client auto-detects `ws://` vs `wss://` from the page URL, so HTTPS hosts
work with no change.

---

## How it fits together

```
public/
  shared.js    physics, weapons, map, hit detection - shared by client & server
  game.js      the rules: CTF, combat, pickups, match flow (GameHost)
  bots.js      bots that play as ordinary players (no stat cheating)
  nav.js       navmesh + pathfinding for bots
  offline.js   runs GameHost in the browser so you can play without a server
  sprites.js   composites LPC sprite sheets and the weapon viewmodel
  audio.js     sound engine: positional SFX + streaming music with crossfade
  client.js    rendering, netcode, HUD, menu
  index.html   markup and styling
  vendor/      three.js (vendored, no CDN)
  sprites/     packed sprite atlases + manifest
  audio/       sfx/ (OGG effects) and music/ (MP3 tracks)
server.js      thin WebSocket transport around GameHost
tools/
  build-sprites.py   re-packs LPC art into the atlases in public/sprites/
```

The same `GameHost` runs on the server and (via `offline.js`) in the browser,
so online and offline play cannot drift apart. The server is authoritative; the
client predicts your own movement and reconciles against snapshots, and
interpolates everyone else.

---

## Testing

```bash
npm test
```

Runs six suites - core physics, networked rules, combat & capture flow, bots,
a stability soak, and a full end-to-end server handshake over a real socket.

> **Note:** the tests verify logic, geometry, physics, and networking. Whether
> the game *feels* good - frame rate, how a swing reads, HUD clarity - is
> something to judge by playing it in a browser.

---

## Credits

Character and weapon art is from the **Universal LPC Spritesheet** project and
is licensed under CC-BY-SA / GPL - see **CREDITS.md** for the full artist list
and what the licenses require. The engine is **three.js** (MIT). All game code
is original.
