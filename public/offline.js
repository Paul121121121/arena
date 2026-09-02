// offline.js
// Runs the whole game inside the browser tab, with bots for company.
//
// The trick is that it pretends to be a WebSocket. The client code does not
// branch on online versus offline - it is handed something with send(),
// onmessage and readyState, and talks to it exactly the same way. So offline
// mode exercises the real netcode: prediction, reconciliation, interpolation
// and lag compensation all still run, just with zero latency.

(function (exports, Game, Bots, Shared) {
  'use strict';

  function LocalSocket(options) {
    options = options || {};
    const self = this;

    this.readyState = 0;          // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    this._botCount = Math.max(1, Math.min(5, options.bots || 5));
    this._skill = options.skill || 'regular';
    this._humanId = null;
    this._bots = [];
    this._timer = null;
    this._pingTimer = null;

    this._host = new Game.GameHost({
      send: function (id, msg) {
        if (id !== self._humanId) return;         // bots have nowhere to send to
        if (!self.onmessage) return;
        // Deliver asynchronously, the way a real socket would, so the client
        // never re-enters itself mid-send.
        Promise.resolve().then(function () {
          if (self.readyState === 1 && self.onmessage) {
            self.onmessage({ data: JSON.stringify(msg) });
          }
        });
      }
    });

    setTimeout(function () {
      self.readyState = 1;                         // OPEN
      if (self.onopen) self.onopen();
    }, 0);
  }

  LocalSocket.prototype.send = function (raw) {
    if (this.readyState !== 1) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (this._humanId === null) {
      if (msg.type !== 'join') return;
      this._start(msg.name, msg.look);
      return;
    }
    this._host.handle(this._humanId, msg);
  };

  LocalSocket.prototype._start = function (name, look) {
    const self = this;
    const host = this._host;

    const joined = host.join(name, { look: look });
    this._humanId = joined.id;

    // Bots fill the room after the player, so team assignment balances around
    // them rather than the other way round.
    this._bots = Bots.spawnBots(host, this._botCount, this._skill);

    // The welcome was built before the bots existed, so refresh the roster
    joined.welcome.players = [...host.players.values()].map(function (p) {
      return host.rosterEntry(p);
    });
    joined.welcome.offline = true;
    joined.welcome.botSkill = this._skill;

    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(joined.welcome) });
    }
    host.sendRoster();

    const tickMs = 1000 / Shared.CONFIG.TICK_HZ;
    let last = performance.now();

    this._timer = setInterval(function () {
      const t = performance.now();
      const dt = Math.min((t - last) / 1000, 0.1);
      last = t;
      Bots.driveBots(host, self._bots, dt);
      host.tick();
    }, tickMs);

    // Keeps the ping readout honest (it will say 0)
    this._pingTimer = setInterval(function () { host.pingAll(); }, 2500);
  };

  LocalSocket.prototype.close = function () {
    this.readyState = 3;                            // CLOSED
    clearInterval(this._timer);
    clearInterval(this._pingTimer);
    if (this.onclose) this.onclose();
  };

  // Convenience for the client
  function createLocalSocket(options) {
    return new LocalSocket(options);
  }

  exports.LocalSocket = LocalSocket;
  exports.createLocalSocket = createLocalSocket;

})(
  typeof module !== 'undefined' && module.exports ? module.exports : (window.Offline = {}),
  typeof module !== 'undefined' && module.exports ? require('./game.js') : window.Game,
  typeof module !== 'undefined' && module.exports ? require('./bots.js') : window.Bots,
  typeof module !== 'undefined' && module.exports ? require('./shared.js') : window.Shared
);
