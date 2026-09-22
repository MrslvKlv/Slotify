/* Slotify — reel engine.
 *
 * Design notes
 * ------------
 * A reel's position is a single float `offset`, measured in SYMBOLS (not
 * pixels), into its strip.  Rendering is one `translate3d` per reel per
 * frame — no layout, fully GPU composited.
 *
 * The strip is a recycling window of only ROWS + 2 cells rather than the
 * whole 48-symbol strip.  Translation is by the FRACTIONAL part of the
 * offset alone, so the moving layer is never taller than ~5 cells; each
 * time the integer part changes, the window's cells are re-pointed at the
 * symbols now under them.  Rendering the entire strip instead would build
 * a ~8500px composited layer per reel, which browsers rasterise only
 * partially — that showed up as intermittently blank reels.
 *
 * Symbol art is a CSS background rather than an <img> so re-pointing a
 * cell swaps a cached bitmap synchronously and cannot flash empty.
 *
 * Motion runs through five phases:
 *   BACK    tiny reverse nudge (anticipation)
 *   ACCEL   eased ramp up to cruise speed
 *   CRUISE  constant velocity until this reel's stop time
 *   LAND    eased braking to just PAST the target
 *   SETTLE  damped wobble back onto the target
 *
 * The important trick for smoothness: easeOutQuart has derivative
 * 4*distance/duration at t=0, so choosing duration = 4*distance/speed
 * makes the braking curve start at exactly the cruise velocity.  Without
 * that the reel visibly "catches" the moment it begins to stop. */
(function (global) {
  'use strict';

  var NS = (global.Slotify = global.Slotify || {});
  var U = NS.util;

  var STATE = {
    IDLE: 'idle',
    BACK: 'back',
    ACCEL: 'accel',
    CRUISE: 'cruise',
    LAND: 'land',
    SETTLE: 'settle'
  };

  /* ================================================================== *
   * Reel
   * ================================================================== */
  function Reel(index, el, strip, opts) {
    this.index = index;
    this.el = el;
    this.strip = strip;
    this.L = strip.length;
    this.rows = opts.rows;
    this.symbols = opts.symbols;
    this.motionBlur = opts.motionBlur !== false;

    this.offset = Math.floor(Math.random() * this.L);
    this.target = this.offset;
    this.state = STATE.IDLE;
    this.speed = 0;
    this.cellH = 0;
    this._blur = -1;

    this._build();
    this.measure();
    this.render();
  }

  Reel.prototype._build = function () {
    var strip = document.createElement('div');
    strip.className = 'reel-strip';

    this.cells = [];
    this.cellIds = [];

    /* One spare cell above and below the three visible rows covers any
     * fractional scroll position. */
    var windowSize = this.rows + 2;

    for (var i = 0; i < windowSize; i++) {
      var cell = document.createElement('div');
      cell.className = 'cell';

      var art = document.createElement('span');
      art.className = 'cell__art';

      var frame = document.createElement('span');
      frame.className = 'cell__frame';

      cell.appendChild(art);
      cell.appendChild(frame);
      strip.appendChild(cell);

      this.cells.push(cell);
      this.cellIds.push(null);
    }

    this.el.innerHTML = '';
    this.el.appendChild(strip);

    /* Held (sticky) symbols live in their own layer above the strip so
     * they stay put while the reel scrolls underneath them. */
    var holds = document.createElement('div');
    holds.className = 'reel__holds';
    this.el.appendChild(holds);

    var flash = document.createElement('span');
    flash.className = 'reel__flash';
    this.el.appendChild(flash);

    this.stripEl = strip;
    this.holdsEl = holds;
    this.flashEl = flash;
    this._top = null;
    this.holds = [];
    this.holdCells = {};
  };

  /* Swap in a different symbol strip (base <-> free spins).  Lengths
   * match, so the current landing index stays valid. */
  Reel.prototype.setStrip = function (strip) {
    if (!strip || strip === this.strip) return;
    this.strip = strip;
    this._top = null;          /* force the recycling window to repaint */
    this.render();
  };

  /* `list` is [{ row, symbolId, spinsLeft, level, fresh }]. Rows are
   * positioned in percentages so the layer needs no resize handling. */
  Reel.prototype.setHolds = function (list) {
    var self = this;
    this.holds = list || [];
    this.holdsEl.innerHTML = '';
    this.holdCells = {};

    this.holds.forEach(function (h) {
      var sym = self.symbols[h.symbolId];

      var cell = document.createElement('div');
      cell.className = 'hold-cell' + (h.fresh ? ' is-fresh' : '');
      cell.style.setProperty('--hold-row', String(h.row));
      cell.dataset.symbol = h.symbolId;
      cell.dataset.tier = sym.tier;

      var art = document.createElement('span');
      art.className = 'cell__art';
      art.style.backgroundImage = 'url("' + sym.img + '")';

      var frame = document.createElement('span');
      frame.className = 'cell__frame';

      var pips = document.createElement('span');
      pips.className = 'hold-cell__pips';
      pips.title = h.spinsLeft + ' spins remaining';
      for (var i = 0; i < h.spinsLeft; i++) {
        var pip = document.createElement('i');
        pips.appendChild(pip);
      }

      cell.appendChild(art);
      cell.appendChild(frame);
      cell.appendChild(pips);

      /* Stacked wilds carry a payout multiplier. */
      if (h.level > 1) {
        var mult = document.createElement('span');
        mult.className = 'hold-cell__mult';
        mult.textContent = '×' + h.level;
        mult.title = 'Wins through this wild pay x' + h.level;
        cell.appendChild(mult);
        cell.classList.add('is-stacked');
        cell.style.setProperty('--hold-level', String(h.level));
      }
      self.holdsEl.appendChild(cell);
      self.holdCells[h.row] = cell;
    });

    this.el.classList.toggle('has-holds', this.holds.length > 0);
  };

  Reel.prototype.clearHolds = function () { this.setHolds([]); };

  /* Point window cell `k` at a symbol.  Only touches the DOM when the
   * symbol actually changed, and never rewrites className so the win
   * highlighting applied by the game controller survives. */
  Reel.prototype._setCell = function (k, id) {
    if (this.cellIds[k] === id) return;
    this.cellIds[k] = id;

    var sym = this.symbols[id];
    var cell = this.cells[k];
    cell.dataset.symbol = id;
    cell.dataset.tier = sym.tier;
    cell.firstChild.style.backgroundImage = 'url("' + sym.img + '")';
  };

  /* Cell height is read from the live layout so the engine stays in sync
   * with whatever the CSS decided (and with any resize). */
  Reel.prototype.measure = function () {
    if (!this.cells.length) return;
    var h = this.cells[0].getBoundingClientRect().height;
    if (h > 0) this.cellH = h;
  };

  Reel.prototype._wrapIndex = function (i) {
    var m = i % this.L;
    return m < 0 ? m + this.L : m;
  };

  Reel.prototype.render = function () {
    var top = Math.floor(this.offset);
    var frac = this.offset - top;

    /* Re-point the recycling window whenever we cross a symbol boundary. */
    if (top !== this._top) {
      this._top = top;
      for (var k = 0; k < this.cells.length; k++) {
        this._setCell(k, this.strip[this._wrapIndex(top + k)]);
      }
    }

    var y = -frac * this.cellH;
    this.stripEl.style.transform = 'translate3d(0,' + y.toFixed(2) + 'px,0)';

    if (!this.motionBlur) return;
    /* Quantise so we only touch the style when the value actually moves. */
    var b = Math.min(6, Math.round(Math.abs(this.speed) * 0.18));
    if (b !== this._blur) {
      this._blur = b;
      this.stripEl.style.filter = b > 0 ? 'blur(' + b + 'px)' : '';
    }
  };

  /* Symbol currently shown at a visible row (0 = top). */
  Reel.prototype.symbolAt = function (row) {
    return this.strip[this._wrapIndex(this.target + row)];
  };

  /* DOM cell for a visible row.  Valid once the reel has landed, where
   * the offset is exactly `target` and window cell k sits on row k.
   * A held symbol covers the strip cell beneath it, so win highlighting
   * has to target the held element or it would light up something the
   * player cannot see. */
  Reel.prototype.cellAt = function (row) {
    return this.holdCells[row] || this.cells[row];
  };

  Reel.prototype.beginSpin = function (now, target, stopAt, cfg) {
    this.target = target;
    this.stopAt = stopAt;
    this.turbo = !!cfg.turbo;
    this.maxSpeed = cfg.maxSpeed;
    this.done = false;

    this.state = STATE.BACK;
    this.phaseStart = now;
    this.phaseDur = this.turbo ? 90 : 150;
    this.phaseFrom = this.offset;
    this.phaseTo = this.offset - (this.turbo ? 0.20 : 0.42);

    this.el.classList.add('is-spinning');
    this.el.classList.remove('is-landed');
  };

  Reel.prototype.setAnticipating = function (on) {
    this.el.classList.toggle('is-anticipating', !!on);
  };

  Reel.prototype._beginLand = function (now) {
    var cur = this.offset;
    var L = this.L;

    /* Travel at least this far so braking never looks abrupt. */
    var minTravel = Math.max(2.5, this.maxSpeed * 0.16);
    var landTarget = Math.ceil((cur + minTravel - this.target) / L) * L + this.target;

    this.overshoot = this.turbo ? 0.16 : 0.30;
    this.landTarget = landTarget;
    this.phaseFrom = cur;
    this.landDist = (landTarget + this.overshoot) - cur;

    /* Velocity-continuous braking — see the header note. */
    this.phaseDur = U.clamp((4 * this.landDist / this.maxSpeed) * 1000, 320, 950);
    this.phaseStart = now;
    this.state = STATE.LAND;

    this.el.classList.remove('is-anticipating');
  };

  Reel.prototype.update = function (now, dt) {
    var p;

    switch (this.state) {
      case STATE.BACK:
        p = U.clamp((now - this.phaseStart) / this.phaseDur, 0, 1);
        this.offset = U.lerp(this.phaseFrom, this.phaseTo, U.easeOutCubic(p));
        this.speed = 0;
        if (p >= 1) {
          this.state = STATE.ACCEL;
          this.phaseStart = now;
          this.phaseDur = this.turbo ? 150 : 270;
        }
        break;

      case STATE.ACCEL:
        p = U.clamp((now - this.phaseStart) / this.phaseDur, 0, 1);
        this.speed = this.maxSpeed * U.easeInQuad(p);
        this.offset += this.speed * dt;
        if (p >= 1) {
          this.speed = this.maxSpeed;
          this.state = STATE.CRUISE;
        }
        break;

      case STATE.CRUISE:
        this.speed = this.maxSpeed;
        this.offset += this.speed * dt;
        if (now >= this.stopAt) this._beginLand(now);
        break;

      case STATE.LAND: {
        p = U.clamp((now - this.phaseStart) / this.phaseDur, 0, 1);
        var prev = this.offset;
        this.offset = this.phaseFrom + this.landDist * U.easeOutQuart(p);
        this.speed = dt > 0 ? (this.offset - prev) / dt : 0;
        if (p >= 1) {
          this.state = STATE.SETTLE;
          this.phaseStart = now;
          this.phaseDur = this.turbo ? 170 : 250;
          this.speed = 0;
          this._onLanded();
        }
        break;
      }

      case STATE.SETTLE:
        p = U.clamp((now - this.phaseStart) / this.phaseDur, 0, 1);
        /* Damped cosine: starts at +overshoot, decays onto the target. */
        this.offset = this.landTarget +
          this.overshoot * Math.exp(-4.2 * p) * Math.cos(p * Math.PI * 1.5);
        this.speed = 0;
        if (p >= 1) {
          this.offset = this.landTarget % this.L;
          this.state = STATE.IDLE;
          this.done = true;
        }
        break;
    }

    this.render();
  };

  Reel.prototype._onLanded = function () {
    this.el.classList.remove('is-spinning');
    this.el.classList.add('is-landed');
    this.flashEl.classList.remove('is-on');
    /* Force a reflow so the flash animation can retrigger back to back. */
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('is-on');
    if (this.onStop) this.onStop(this.index);
  };

  Reel.prototype.isBusy = function () {
    return this.state !== STATE.IDLE;
  };

  /* ================================================================== *
   * ReelSet — owns the animation loop and the shared timing plan
   * ================================================================== */
  function ReelSet(container, cfg, opts) {
    opts = opts || {};
    this.cfg = cfg;
    this.container = container;
    this.reducedMotion = !!opts.reducedMotion;

    this.reels = [];
    for (var i = 0; i < cfg.REELS; i++) {
      var el = document.createElement('div');
      el.className = 'reel';
      el.style.setProperty('--reel-index', String(i));
      container.appendChild(el);

      this.reels.push(new Reel(i, el, cfg.STRIPS[i], {
        rows: cfg.ROWS,
        symbols: cfg.SYMBOLS,
        motionBlur: !this.reducedMotion
      }));
    }

    this._raf = 0;
    this._last = 0;
    this._resolve = null;

    var self = this;
    this._onResize = function () { self.measure(); };

    if (global.ResizeObserver) {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(container);
    } else {
      global.addEventListener('resize', this._onResize);
    }
  }

  /* `strips` is an array of one strip per reel, or null to go back to
   * the base set. */
  ReelSet.prototype.useStrips = function (strips) {
    var source = strips || this.cfg.STRIPS;
    this.reels.forEach(function (reel, i) { reel.setStrip(source[i]); });
  };

  ReelSet.prototype.measure = function () {
    this.reels.forEach(function (r) { r.measure(); r.render(); });
    if (this.onMeasure) this.onMeasure();
  };

  /* What the grid WILL look like for a set of target indices.
   * grid[reel][row] -> symbol id. */
  ReelSet.prototype.gridFor = function (targets) {
    var grid = [];
    for (var i = 0; i < this.reels.length; i++) {
      var reel = this.reels[i];
      var col = [];
      for (var row = 0; row < this.cfg.ROWS; row++) {
        col.push(reel.strip[(targets[i] + row) % reel.L]);
      }
      grid.push(col);
    }
    return grid;
  };

  ReelSet.prototype.randomTargets = function (rng) {
    var self = this;
    return this.reels.map(function (r) {
      return Math.floor(rng() * r.L);
    });
  };

  /* opts: { turbo, anticipateFrom, onStop, onAnticipate } */
  ReelSet.prototype.spin = function (targets, opts) {
    opts = opts || {};
    var self = this;
    var now = performance.now();

    var turbo = !!opts.turbo;
    var reduced = this.reducedMotion;

    var maxSpeed = reduced ? 18 : (turbo ? 42 : 27);
    var lead = reduced ? 420 : (turbo ? 620 : 1150);
    var stagger = reduced ? 60 : (turbo ? 75 : 175);
    var anticipateBonus = reduced ? 0 : 1250;

    this.reels.forEach(function (reel, i) {
      var stopAt = now + lead + i * stagger;
      var anticipating =
        opts.anticipateFrom != null && opts.anticipateFrom >= 0 && i >= opts.anticipateFrom;

      if (anticipating) stopAt += anticipateBonus;

      reel.onStop = opts.onStop || null;
      reel.beginSpin(now, targets[i], stopAt, { turbo: turbo, maxSpeed: maxSpeed });
      reel.setAnticipating(anticipating);

      if (anticipating && i === opts.anticipateFrom && opts.onAnticipate) {
        opts.onAnticipate(i);
      }
    });

    return new Promise(function (resolve) {
      self._resolve = resolve;
      self._start();
    });
  };

  ReelSet.prototype._start = function () {
    if (this._raf) return;
    var self = this;
    this._last = performance.now();

    this._raf = requestAnimationFrame(function loop(now) {
      /* Clamp dt so a backgrounded tab doesn't teleport the reels. */
      var dt = Math.min(0.05, (now - self._last) / 1000);
      self._last = now;

      var busy = false;
      for (var i = 0; i < self.reels.length; i++) {
        var r = self.reels[i];
        if (r.isBusy()) { r.update(now, dt); busy = true; }
      }

      if (busy) {
        self._raf = requestAnimationFrame(loop);
      } else {
        self._raf = 0;
        var done = self._resolve;
        self._resolve = null;
        if (done) done();
      }
    });
  };

  ReelSet.prototype.destroy = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    else global.removeEventListener('resize', this._onResize);
  };

  NS.Reel = Reel;
  NS.ReelSet = ReelSet;
})(window);
