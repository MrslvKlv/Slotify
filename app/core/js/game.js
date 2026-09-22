/* Slotify — game controller: state, spin flow and win presentation. */
(function (global) {
  'use strict';

  var NS = (global.Slotify = global.Slotify || {});
  var cfg = NS.config;
  var U = NS.util;

  function $(id) { return document.getElementById(id); }

  /* Presentation caps for high line counts. */
  var MAX_GHOST_LINES = 8;    /* faint lines drawn behind the focused one */
  var MAX_CYCLE_LINES = 12;   /* wins stepped through one at a time */

  /* ================================================================== *
   * Asset preloading
   * ================================================================== */
  function preload(urls, onProgress) {
    var done = 0;
    var total = urls.length;

    return Promise.all(urls.map(function (src) {
      return new Promise(function (resolve) {
        var img = new Image();
        var finish = function () {
          done++;
          if (onProgress) onProgress(done / total);
          resolve();
        };
        img.onload = finish;
        img.onerror = finish;   /* a missing asset must not hang the boot */
        img.src = src;
      });
    }));
  }

  /* ================================================================== *
   * Game
   * ================================================================== */
  function Game() {
    this.reducedMotion = U.prefersReducedMotion();
    this.rng = Math.random;

    this.balance = cfg.START_BALANCE;
    this.jackpot = cfg.START_JACKPOT;
    this.betIndex = 0;
    this.linesIndex = cfg.LINES_OPTIONS.length - 1;   /* all 20 lines */
    this.turbo = false;
    this.soundOn = true;

    this.spinning = false;
    this.lastWin = 0;
    this.freeSpins = {
      count: 0, total: 0, multiplier: cfg.FREE_SPIN_MULTIPLIER,
      won: 0,          /* banked this round, paid out when it ends */
      active: false
    };
    this.auto = { remaining: 0, infinite: false };
    this.stickyWilds = [];      /* [{ reel, row, spinsLeft }] during free spins */

    this._markedCells = [];
    this._cycleTimer = 0;
    this._nextSpinTimer = 0;
    this._countRaf = 0;

    this.loadState();

    this.audio = new NS.AudioBus();
    this.audio.load({
      spin: 'audio/spin.wav',
      win: 'audio/win.wav',
      click: 'audio/click.wav'
    });
    this.audio.setEnabled(this.soundOn);

    this.cacheDom();
    this.buildReels();
    this.buildPaytable();
    this.bindEvents();
    this.render();
  }

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */
  Game.prototype.loadState = function () {
    try {
      var raw = localStorage.getItem(cfg.STORAGE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (typeof s.balance === 'number' && isFinite(s.balance)) this.balance = Math.max(0, s.balance);
      if (typeof s.jackpot === 'number' && isFinite(s.jackpot)) this.jackpot = s.jackpot;
      if (typeof s.betIndex === 'number') this.betIndex = U.clamp(s.betIndex | 0, 0, cfg.BET_STEPS.length - 1);
      if (typeof s.linesIndex === 'number') this.linesIndex = U.clamp(s.linesIndex | 0, 0, cfg.LINES_OPTIONS.length - 1);
      if (typeof s.turbo === 'boolean') this.turbo = s.turbo;
      if (typeof s.soundOn === 'boolean') this.soundOn = s.soundOn;
    } catch (e) { /* corrupt or unavailable storage — fall back to defaults */ }
  };

  Game.prototype.saveState = function () {
    try {
      localStorage.setItem(cfg.STORAGE_KEY, JSON.stringify({
        balance: this.balance,
        jackpot: this.jackpot,
        betIndex: this.betIndex,
        linesIndex: this.linesIndex,
        turbo: this.turbo,
        soundOn: this.soundOn
      }));
    } catch (e) { /* private mode, quota — non-fatal */ }
  };

  /* ------------------------------------------------------------------ *
   * DOM
   * ------------------------------------------------------------------ */
  Game.prototype.cacheDom = function () {
    this.el = {
      balance: $('balanceValue'),
      jackpot: $('jackpotValue'),
      win: $('winValue'),
      bet: $('betValue'),
      lines: $('linesValue'),
      totalBet: $('totalBetValue'),

      reels: $('reels'),
      lineFx: $('lineFx'),
      badge: $('lineBadge'),
      stage: $('stage'),

      spinBtn: $('spinBtn'),
      spinLabel: $('spinLabel'),
      autoBtn: $('autoBtn'),
      autoMenu: $('autoMenu'),
      autoIcon: $('autoIcon'),
      autoLabel: $('autoLabel'),
      autoCount: $('autoCount'),
      soundIcon: $('soundIcon'),
      turboBtn: $('turboBtn'),
      soundBtn: $('soundBtn'),
      infoBtn: $('infoBtn'),
      maxBetBtn: $('maxBetBtn'),
      addCoinsBtn: $('addCoinsBtn'),
      betUp: $('betUp'),
      betDown: $('betDown'),
      linesUp: $('linesUp'),
      linesDown: $('linesDown'),

      fsPill: $('fsPill'),
      fsCount: $('fsCount'),
      fsBanked: $('fsBanked'),
      roundTotal: $('roundTotal'),
      roundTotalValue: $('roundTotalValue'),
      roundCollect: $('roundCollect'),
      bonusLayer: $('bonusLayer'),
      fsBanner: $('fsBanner'),
      fsBannerCount: $('fsBannerCount'),
      fsBannerNote: $('fsBannerNote'),

      bigWin: $('bigWin'),
      bigWinLabel: $('bigWinLabel'),
      bigWinValue: $('bigWinValue'),

      modal: $('paytableModal'),
      modalClose: $('modalClose'),
      paytableBody: $('paytableBody'),
      freeCards: $('freeCards'),
      bonusCards: $('bonusCards'),
      linesGrid: $('linesGrid'),

      toast: $('toast')
    };
  };

  Game.prototype.buildReels = function () {
    var self = this;

    this.reelSet = new NS.ReelSet(this.el.reels, cfg, {
      reducedMotion: this.reducedMotion
    });

    this.overlay = new NS.LineOverlay(this.el.lineFx, this.el.reels, cfg);
    this.reelSet.onMeasure = function () { self.overlay.measure(); };

    /* First measure once layout has settled. */
    requestAnimationFrame(function () { self.reelSet.measure(); });
  };

  /* ------------------------------------------------------------------ *
   * Derived values
   * ------------------------------------------------------------------ */
  Game.prototype.betPerLine = function () { return cfg.BET_STEPS[this.betIndex]; };
  Game.prototype.activeLines = function () { return cfg.LINES_OPTIONS[this.linesIndex]; };
  Game.prototype.totalBet = function () { return this.betPerLine() * this.activeLines(); };
  Game.prototype.inFreeSpins = function () { return this.freeSpins.count > 0; };

  /* ------------------------------------------------------------------ *
   * Rendering the HUD
   * ------------------------------------------------------------------ */
  Game.prototype.render = function () {
    var e = this.el;
    /* Painted meter windows have a fixed width, so these abbreviate once
     * a figure passes 100M (see util.compact).  The collection screens —
     * the bonus chamber and the end-of-round tally — stay on util.money. */
    e.balance.textContent = U.compact(this.balance);
    e.jackpot.textContent = U.compact(this.jackpot);
    e.bet.textContent = U.compact(this.betPerLine());
    /* Every possible path is live at the top setting — "MAX" reads
     * better there than the raw 243. */
    var lines = this.activeLines();
    e.lines.textContent = lines >= cfg.PAYLINES.length ? 'MAX' : String(lines);
    e.lines.classList.toggle('is-max', lines >= cfg.PAYLINES.length);
    e.totalBet.textContent = U.compact(this.totalBet());
    e.win.textContent = U.compact(this.lastWin);

    e.turboBtn.classList.toggle('is-active', this.turbo);
    e.turboBtn.setAttribute('aria-pressed', String(this.turbo));

    e.soundIcon.setAttribute('href', this.soundOn ? '#ico-sound-on' : '#ico-sound-off');
    e.soundBtn.setAttribute('aria-pressed', String(this.soundOn));

    /* Only the label and icon change here — never innerHTML/textContent
     * on the button itself, which would delete the inline <svg>. */
    var autoActive = this.auto.remaining > 0 || this.auto.infinite;
    e.autoBtn.classList.toggle('is-active', autoActive);
    e.autoIcon.setAttribute('href', autoActive ? '#ico-stop' : '#ico-auto');
    e.autoLabel.textContent = autoActive ? 'STOP' : 'AUTO';
    e.autoCount.hidden = !autoActive;
    e.autoCount.textContent = this.auto.infinite ? '∞' : String(this.auto.remaining);

    var fs = this.inFreeSpins() || this.freeSpins.active;
    e.fsPill.hidden = !fs;
    e.fsCount.textContent = String(this.freeSpins.count);
    e.fsBanked.hidden = this.freeSpins.won <= 0;
    e.fsBanked.textContent = '$' + U.compact(this.freeSpins.won);
    document.body.classList.toggle('is-free-spins', fs);

    /* Free spins must play out at the bet that triggered them, so the
     * stake controls lock — matching the guards in adjustBet/adjustLines,
     * which would otherwise refuse a click that still looked available. */
    var stakeLocked = this.spinning || fs;
    e.betUp.disabled = stakeLocked || this.betIndex >= cfg.BET_STEPS.length - 1;
    e.betDown.disabled = stakeLocked || this.betIndex <= 0;
    e.linesUp.disabled = stakeLocked || this.linesIndex >= cfg.LINES_OPTIONS.length - 1;
    e.linesDown.disabled = stakeLocked || this.linesIndex <= 0;
    e.maxBetBtn.disabled = stakeLocked;

    var canSpin = fs || this.balance >= this.totalBet();
    e.spinBtn.disabled = this.spinning || !canSpin;
    e.spinBtn.classList.toggle('is-spinning', this.spinning);
    e.spinLabel.textContent = this.spinning ? '' : (fs ? 'FREE' : 'SPIN');
  };

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */
  Game.prototype.bindEvents = function () {
    var self = this;
    var e = this.el;

    /* Any pointer press satisfies the browser's audio gesture rule. */
    var unlock = function () { self.audio.unlock(); };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });

    e.spinBtn.addEventListener('click', function () {
      if (self.auto.remaining > 0 || self.auto.infinite) { self.stopAuto(); return; }
      self.spin();
    });

    e.betUp.addEventListener('click', function () { self.adjustBet(1); });
    e.betDown.addEventListener('click', function () { self.adjustBet(-1); });
    e.linesUp.addEventListener('click', function () { self.adjustLines(1); });
    e.linesDown.addEventListener('click', function () { self.adjustLines(-1); });

    /* Max bet means the biggest bet the balance can actually cover, not
     * the top of the ladder — otherwise it just disables SPIN. */
    e.maxBetBtn.addEventListener('click', function () {
      if (self.spinning || self.inFreeSpins()) return;
      self.linesIndex = cfg.LINES_OPTIONS.length - 1;

      var lines = self.activeLines();
      var pick = 0;
      for (var i = 0; i < cfg.BET_STEPS.length; i++) {
        if (cfg.BET_STEPS[i] * lines <= self.balance) pick = i;
      }
      self.betIndex = pick;

      self.audio.click();
      self.saveState();
      self.render();
    });

    e.addCoinsBtn.addEventListener('click', function () {
      self.balance += cfg.TOP_UP;
      self.audio.click();
      self.saveState();
      self.render();
      self.toast('+' + U.money(cfg.TOP_UP) + ' credits added');
    });

    e.turboBtn.addEventListener('click', function () {
      self.turbo = !self.turbo;
      self.audio.click();
      self.saveState();
      self.render();
    });

    e.soundBtn.addEventListener('click', function () {
      self.soundOn = !self.soundOn;
      self.audio.setEnabled(self.soundOn);
      self.audio.click();
      self.saveState();
      self.render();
    });

    /* --- auto play menu --- */
    e.autoBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (self.auto.remaining > 0 || self.auto.infinite) { self.stopAuto(); return; }
      e.autoMenu.hidden = !e.autoMenu.hidden;
      self.audio.click();
    });

    e.autoMenu.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-auto]');
      if (!btn) return;
      var v = btn.dataset.auto;
      e.autoMenu.hidden = true;
      self.startAuto(v === 'inf' ? Infinity : parseInt(v, 10));
    });

    document.addEventListener('click', function (ev) {
      if (!e.autoMenu.hidden && !e.autoMenu.contains(ev.target) && ev.target !== e.autoBtn) {
        e.autoMenu.hidden = true;
      }
    });

    /* --- paytable --- */
    e.infoBtn.addEventListener('click', function () { self.openModal(); });
    e.modalClose.addEventListener('click', function () { self.closeModal(); });
    e.modal.addEventListener('click', function (ev) {
      if (ev.target === e.modal) self.closeModal();
    });

    e.bigWin.addEventListener('click', function () { self.dismissBigWin(); });

    /* --- keyboard --- */
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { self.closeModal(); e.autoMenu.hidden = true; return; }
      if (ev.target.matches('input, textarea')) return;

      switch (ev.key) {
        case ' ':
        case 'Enter':
          ev.preventDefault();
          if (!e.spinBtn.disabled) e.spinBtn.click();
          break;
        case 'ArrowUp': ev.preventDefault(); self.adjustBet(1); break;
        case 'ArrowDown': ev.preventDefault(); self.adjustBet(-1); break;
        case 'ArrowRight': ev.preventDefault(); self.adjustLines(1); break;
        case 'ArrowLeft': ev.preventDefault(); self.adjustLines(-1); break;
        case 'a': case 'A': e.autoBtn.click(); break;
        case 't': case 'T': e.turboBtn.click(); break;
        case 'm': case 'M': e.soundBtn.click(); break;
        case 'i': case 'I': self.openModal(); break;
      }
    });

    /* Pause autoplay when the tab is hidden — rAF stalls there anyway. */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) self.stopAuto();
    });

    global.addEventListener('resize', function () {
      self.overlay.measure();
    });
  };

  Game.prototype.adjustBet = function (dir) {
    if (this.spinning || this.inFreeSpins()) return;
    var next = U.clamp(this.betIndex + dir, 0, cfg.BET_STEPS.length - 1);
    if (next === this.betIndex) return;
    this.betIndex = next;
    this.audio.click();
    this.saveState();
    this.render();
  };

  Game.prototype.adjustLines = function (dir) {
    if (this.spinning || this.inFreeSpins()) return;
    var next = U.clamp(this.linesIndex + dir, 0, cfg.LINES_OPTIONS.length - 1);
    if (next === this.linesIndex) return;
    this.linesIndex = next;
    this.audio.click();
    this.saveState();
    this.render();
    this.previewLines();
  };

  /* Briefly ghost the active lines so changing the count is legible. */
  Game.prototype.previewLines = function () {
    var self = this;
    var idx = [];
    for (var i = 0; i < this.activeLines(); i++) idx.push(i);

    this.overlay.measure();
    this.overlay.drawAll(idx);

    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(function () {
      if (!self.spinning) self.overlay.clear();
    }, 900);
  };

  /* ------------------------------------------------------------------ *
   * Auto play
   * ------------------------------------------------------------------ */
  Game.prototype.startAuto = function (n) {
    this.auto.infinite = !isFinite(n);
    this.auto.remaining = this.auto.infinite ? Infinity : n;
    this.render();
    if (!this.spinning) this.spin();
  };

  Game.prototype.stopAuto = function () {
    this.auto.remaining = 0;
    this.auto.infinite = false;
    clearTimeout(this._nextSpinTimer);
    this.render();
  };

  /* ------------------------------------------------------------------ *
   * Spin
   * ------------------------------------------------------------------ */
  Game.prototype.spin = function () {
    var self = this;
    if (this.spinning) return;

    var free = this.inFreeSpins();
    var bet = this.totalBet();

    if (!free && this.balance < bet) {
      this.audio.denied();
      this.toast('Not enough credits — lower your bet or add more');
      this.stopAuto();
      return;
    }

    this.spinning = true;
    this.clearPresentation();

    if (free) {
      this.freeSpins.count--;
    } else {
      this.balance -= bet;
      this.jackpot += bet * cfg.JACKPOT_RATE;
    }

    this.lastWin = 0;
    this.render();
    this.audio.spinStart();

    var targets = this.reelSet.randomTargets(this.rng);
    var grid = this.reelSet.gridFor(targets);

    /* Wilds the reels genuinely landed, captured BEFORE sticky wilds are
     * painted on. Reading them afterwards would let every held wild renew
     * its own life each spin, so holds would never expire and the board
     * would silt up with wilds. */
    var landedWilds = this.wildCells(grid);
    if (free) this.applySticky(grid);

    /* Anticipation: if the first two reels both show a scatter, hold the
     * third reel spinning — the classic "will it land?" beat. */
    var anticipateFrom = -1;
    if (this.hasScatter(grid, 0) && this.hasScatter(grid, 1)) anticipateFrom = 2;

    this.reelSet.spin(targets, {
      turbo: this.turbo,
      anticipateFrom: anticipateFrom,
      onStop: function (i) { self.audio.reelStop(i); },
      onAnticipate: function () { self.audio.anticipation(); }
    }).then(function () {
      self.audio.spinEnd();
      self.onReelsStopped(grid, bet, free, landedWilds);
    });
  };

  /* ------------------------------------------------------------------ *
   * Sticky wilds
   * ------------------------------------------------------------------ */
  Game.prototype.wildCells = function (grid) {
    var out = [];
    for (var r = 0; r < cfg.REELS; r++) {
      for (var row = 0; row < cfg.ROWS; row++) {
        if (cfg.SYMBOLS[grid[r][row]].wild) out.push({ reel: r, row: row });
      }
    }
    return out;
  };

  /* Held wilds overwrite whatever the reels stopped on beneath them. */
  Game.prototype.applySticky = function (grid) {
    this.stickyWilds.forEach(function (h) { grid[h.reel][h.row] = 'wild'; });
  };

  Game.prototype.findSticky = function (reel, row) {
    for (var i = 0; i < this.stickyWilds.length; i++) {
      var h = this.stickyWilds[i];
      if (h.reel === reel && h.row === row) return h;
    }
    return null;
  };

  /* Lock the wilds showing when the bonus was won. */
  Game.prototype.seedSticky = function (landed) {
    this.stickyWilds = landed.map(function (c) {
      return {
        reel: c.reel, row: c.row,
        spinsLeft: cfg.STICKY_WILD_SPINS, level: 1, fresh: true
      };
    });
    this.renderSticky();
    return this.stickyWilds.length;
  };

  /* Age the board, drop expired holds, then lock in anything new.
   * A wild landing on a cell that already holds one renews its life AND
   * raises its level, which multiplies every line running through it. */
  Game.prototype.updateSticky = function (landed) {
    var self = this;

    this.stickyWilds = this.stickyWilds.filter(function (h) {
      h.spinsLeft--;
      h.fresh = false;
      h.upgraded = false;
      return h.spinsLeft > 0;
    });

    var added = 0, upgraded = 0;
    landed.forEach(function (c) {
      var existing = self.findSticky(c.reel, c.row);
      if (existing) {
        existing.spinsLeft = cfg.STICKY_WILD_SPINS;
        if (existing.level < cfg.STICKY_WILD_MAX_LEVEL) {
          existing.level++;
          existing.upgraded = true;
          upgraded++;
        }
      } else {
        self.stickyWilds.push({
          reel: c.reel, row: c.row,
          spinsLeft: cfg.STICKY_WILD_SPINS, level: 1, fresh: true
        });
        added++;
      }
    });

    this.renderSticky();
    return { added: added, upgraded: upgraded };
  };

  Game.prototype.renderSticky = function () {
    var byReel = [];
    for (var i = 0; i < cfg.REELS; i++) byReel.push([]);

    this.stickyWilds.forEach(function (h) {
      byReel[h.reel].push({
        row: h.row, symbolId: 'wild', spinsLeft: h.spinsLeft,
        level: h.level, fresh: h.fresh || h.upgraded
      });
    });

    this.reelSet.reels.forEach(function (reel, i) { reel.setHolds(byReel[i]); });
  };

  /* Feeds wins.evaluate so a line pays the product of the wild levels it
   * crosses. */
  Game.prototype.stickyMultiplier = function () {
    var self = this;
    if (!this.stickyWilds.length) return null;
    return function (reel, row) {
      var h = self.findSticky(reel, row);
      return h ? h.level : 1;
    };
  };

  Game.prototype.clearSticky = function () {
    this.stickyWilds = [];
    this.renderSticky();
  };

  Game.prototype.hasScatter = function (grid, reel) {
    for (var r = 0; r < cfg.ROWS; r++) {
      if (cfg.SYMBOLS[grid[reel][r]].scatter) return true;
    }
    return false;
  };

  Game.prototype.onReelsStopped = function (grid, bet, wasFree, landedWilds) {
    var self = this;
    landedWilds = landedWilds || [];

    var result = NS.wins.evaluate(grid, cfg, this.betPerLine(), this.activeLines(), bet, {
      cellMultiplier: wasFree ? this.stickyMultiplier() : null
    });

    var multiplier = wasFree ? this.freeSpins.multiplier : 1;
    if (multiplier !== 1 && result.total > 0) {
      result.lines.forEach(function (l) { l.amount *= multiplier; });
      result.scatter.amount *= multiplier;
      result.lineTotal *= multiplier;
      result.total *= multiplier;
    }
    result.multiplier = multiplier;

    /* Only worth computing when nothing paid AND nothing triggered — it
     * explains the silence, and a free-spins award is not silence.  It
     * also walks every active line, so skipping it on a trigger spin
     * keeps the scan off the frame that has a banner to raise. */
    if (result.total === 0 && !result.scatter.triggersFreeSpins) {
      result.nearMiss = NS.wins.findNearMiss(grid, cfg, this.activeLines());
    }

    if (result.jackpotHit) {
      result.jackpotAmount = Math.floor(this.jackpot);
      result.total += result.jackpotAmount;
      this.jackpot = cfg.START_JACKPOT;
    }

    /* While a free round is running, wins are banked rather than paid —
     * they land in the balance in one lump when the round ends. */
    this._bankToFreeRound = wasFree;

    this.presentWins(result, bet).then(function () {
      /* Free spins are awarded after the win is shown, so the two
       * celebrations don't collide. */
      if (result.scatter.triggersFreeSpins) {
        var award = cfg.FREE_SPINS[Math.min(result.scatter.count, 5)] || 0;
        if (award > 0) {
          self.freeSpins.count += award;
          self.freeSpins.total += award;

          /* A fresh round locks whatever wilds are on screen right now;
           * a retrigger leaves the existing board alone. */
          var locked;
          if (wasFree) {
            locked = self.stickyWilds.length;
          } else {
            self.freeSpins.won = 0;
            self.freeSpins.active = true;
            locked = self.seedSticky(landedWilds);
          }
          if (!wasFree && locked > 0) self.audio.stickyLock(0);

          /* The banner is on screen the moment this returns, so swapping
           * to the wild-rich strips now happens behind it. */
          var banner = self.showFreeSpinsBanner(award, wasFree ? 0 : locked);
          self.enterFreeMode();
          return banner;
        }
      }
    }).then(function () {
      if (wasFree) {
        var changed = self.updateSticky(landedWilds);
        var cues = changed.added + changed.upgraded;
        for (var i = 0; i < cues; i++) self.audio.stickyLock(i);
      }
      /* Round over: pay out everything banked, then go back to base.
       * Held wilds alone are enough to mean a round is winding down, so
       * the board can never be left locked if `active` was missed. */
      if (self.freeSpins.count === 0 &&
          (self.freeSpins.active || self.stickyWilds.length)) {
        return self.endFreeRound();
      }
    }).then(function () {
      if (result.bonus && result.bonus.triggers) return self.runBonusGame(result, bet);
    }).then(function () {
      self.finishSpin(result);
    });
  };

  /* ------------------------------------------------------------------ *
   * Free-spin round
   * ------------------------------------------------------------------ */

  /* Swapped while the award banner covers the stage, so the symbols
   * changing underneath is never visible. */
  Game.prototype.enterFreeMode = function () {
    this.reelSet.useStrips(cfg.FREE_STRIPS);
  };

  Game.prototype.endFreeRound = function () {
    var self = this;
    var won = this.freeSpins.won;

    this.freeSpins.active = false;

    if (won <= 0) {
      this.clearSticky();
      this.reelSet.useStrips(null);
      this.render();
      return Promise.resolve();
    }

    /* Same trick as entering: the tally covers the stage, so the held
     * wilds clearing and the strips reverting stay out of sight. */
    var tally = this.showRoundTotal(won);
    this.clearSticky();
    this.reelSet.useStrips(null);

    return tally.then(function () {
      self.balance += won;
      self.lastWin = won;
      self.freeSpins.won = 0;
      self.saveState();
      self.render();
    });
  };

  /* Credit a win: banked during a free round, straight to balance
   * otherwise. */
  Game.prototype.creditWin = function (amount) {
    if (this._bankToFreeRound && this.freeSpins.active) {
      this.freeSpins.won += amount;
    } else {
      this.balance += amount;
    }
  };

  Game.prototype.finishSpin = function (result) {
    var self = this;

    this.spinning = false;
    this.saveState();
    this.render();

    var hadWin = result.total > 0;
    var delay = this.turbo ? 320 : 700;
    if (hadWin) delay += this.turbo ? 400 : 1100;

    var wantsAnother = this.inFreeSpins() || this.auto.infinite || this.auto.remaining > 0;
    if (!wantsAnother) return;

    /* Free spins run on the house — they don't consume an auto credit. */
    if (!this.inFreeSpins() && !this.auto.infinite) {
      this.auto.remaining--;
      this.render();
      if (this.auto.remaining <= 0) {
        this.stopAuto();
        return;
      }
    }

    if (!this.inFreeSpins() && this.balance < this.totalBet()) {
      this.stopAuto();
      this.toast('Auto play stopped — not enough credits');
      return;
    }

    clearTimeout(this._nextSpinTimer);
    this._nextSpinTimer = setTimeout(function () { self.spin(); }, delay);
  };

  /* ------------------------------------------------------------------ *
   * Win presentation
   * ------------------------------------------------------------------ */
  Game.prototype.clearPresentation = function () {
    clearInterval(this._cycleTimer);
    clearTimeout(this._previewTimer);
    clearTimeout(this._nearTimer);
    if (this._countRaf) cancelAnimationFrame(this._countRaf);
    this._cycleTimer = 0;
    this._countRaf = 0;

    this._markedCells.forEach(function (c) {
      c.classList.remove('is-win', 'is-dim', 'is-scatter', 'is-near');
    });
    this._markedCells = [];

    this.overlay.clear();
    this.el.badge.hidden = true;
    this.el.badge.classList.remove('is-near-miss');
    this.el.stage.classList.remove('is-showing-win');
  };

  Game.prototype.markCells = function (winKeys, scatterKeys) {
    var self = this;

    /* Drop any marks still on the board.  A spin always clears first, but
     * making this self-contained means a presentation can never inherit
     * highlighting from the one before it. */
    this._markedCells.forEach(function (c) {
      c.classList.remove('is-win', 'is-dim', 'is-scatter', 'is-near', 'is-bonus');
    });
    this._markedCells = [];

    this.reelSet.reels.forEach(function (reel, ri) {
      for (var row = 0; row < cfg.ROWS; row++) {
        var cell = reel.cellAt(row);
        if (!cell) continue;
        var key = ri + ':' + row;

        if (winKeys[key]) {
          cell.classList.add('is-win');
          if (scatterKeys && scatterKeys[key]) cell.classList.add('is-scatter');
        } else {
          cell.classList.add('is-dim');
        }
        self._markedCells.push(cell);
      }
    });
  };

  Game.prototype.presentWins = function (result, bet) {
    var self = this;

    /* The scatter pays no coin any more, so a board whose only event is
     * the free-spins trigger totals zero — but it is the biggest thing
     * that can happen on a base spin, so it still gets the full
     * presentation: scarabs lit, the scatter cue, and a badge reading
     * FREE SPINS.  Only a genuinely empty board falls through to the
     * near-miss hint. */
    var triggers = result.scatter.triggersFreeSpins;

    if (result.total <= 0 && !triggers) {
      if (result.nearMiss) this.showNearMiss(result.nearMiss);
      return Promise.resolve();
    }

    /* A pending near-miss hide timer from the previous spin would blank
     * this badge mid-celebration. */
    clearTimeout(this._nearTimer);
    this.el.badge.classList.remove('is-near-miss');

    this.el.stage.classList.add('is-showing-win');

    var winKeys = {};
    var scatterKeys = {};

    result.lines.forEach(function (l) {
      l.cells.forEach(function (c) { winKeys[c.reel + ':' + c.row] = true; });
    });
    if (result.scatter.amount > 0 || result.scatter.triggersFreeSpins) {
      result.scatter.cells.forEach(function (c) {
        var k = c.reel + ':' + c.row;
        winKeys[k] = true;
        scatterKeys[k] = true;
      });
    }

    this.markCells(winKeys, scatterKeys);

    /* With 100 lines a good spin can win on a dozen at once. Ghosting all
     * of them is unreadable, so only the best few are drawn behind the
     * focused line; the cycle still steps through every win. */
    this.overlay.measure();
    this.overlay.drawAll(result.lines.slice(0, MAX_GHOST_LINES).map(function (l) {
      return l.lineIndex;
    }));

    if (result.scatter.count >= 3) this.audio.scatterHit(result.scatter.count);
    this.audio.win();

    var ratio = bet > 0 ? result.total / bet : 0;
    var tier = null;
    for (var i = 0; i < cfg.WIN_TIERS.length; i++) {
      if (ratio >= cfg.WIN_TIERS[i].at) { tier = cfg.WIN_TIERS[i]; return this.bigWinSequence(result, tier); }
    }

    /* Nothing to count up on a scatter-only trigger — rolling the win
     * meter from 0 to 0 would just stall the board before the banner. */
    if (result.total <= 0) {
      this.startLineCycle(result);
      return Promise.resolve();
    }

    return this.countUp(result.total).then(function () {
      self.startLineCycle(result);
    });
  };

  Game.prototype.bigWinSequence = function (result, tier) {
    var self = this;
    this.audio.fanfare();
    return this.showBigWin(result.total, tier).then(function () {
      self.lastWin = result.total;
      self.creditWin(result.total);
      self.render();
      self.startLineCycle(result);
    });
  };

  /* Roll the win counter up; credits land in the balance at the end. */
  Game.prototype.countUp = function (amount) {
    var self = this;
    var dur = this.turbo || this.reducedMotion ? 260 : Math.min(1500, 420 + amount * 1.2);
    var start = performance.now();
    var ticks = 0;

    return new Promise(function (resolve) {
      (function step(now) {
        var p = U.clamp((now - start) / dur, 0, 1);
        var eased = U.easeOutCubic(p);
        var shown = Math.floor(amount * eased);

        self.el.win.textContent = U.compact(shown);

        var nextTick = Math.floor(eased * 20);
        if (nextTick > ticks) { ticks = nextTick; self.audio.winTick(ticks); }

        if (p < 1) {
          self._countRaf = requestAnimationFrame(step);
        } else {
          self._countRaf = 0;
          self.lastWin = amount;
          self.creditWin(amount);
          self.render();
          resolve();
        }
      })(start);
    });
  };

  /* Step through each winning line one at a time with a label. */
  Game.prototype.startLineCycle = function (result) {
    var self = this;
    var totalLines = result.lines.length;
    var entries = result.lines.slice(0, MAX_CYCLE_LINES);

    if (result.scatter.amount > 0 || result.scatter.triggersFreeSpins) {
      entries.push({
        scatter: true,
        symbolId: 'scatter',
        count: result.scatter.count,
        amount: result.scatter.amount,
        cells: result.scatter.cells
      });
    }

    if (!entries.length) return;

    var i = 0;
    var show = function () {
      var slot = i % entries.length;
      var entry = entries[slot];
      i++;

      if (entry.scatter) {
        self.overlay.clear();
        self.showBadge(entry, result.multiplier, true, slot + 1, entries.length, totalLines);
      } else {
        self.overlay.focusLine(entry);
        self.showBadge(entry, result.multiplier, false, slot + 1, entries.length, totalLines);
      }
      self.audio.lineHighlight();
    };

    show();

    /* A single win stays put — only cycle when there is something to
     * cycle between, otherwise the badge just blinks at the player. */
    if (entries.length > 1) {
      clearInterval(this._cycleTimer);
      this._cycleTimer = setInterval(show, 1500);
    }
  };

  /* "So close" feedback: outline the run that could not pay and say why. */
  Game.prototype.showNearMiss = function (nm) {
    var self = this;
    var sym = cfg.SYMBOLS[nm.symbolId];
    var badge = this.el.badge;

    nm.cells.forEach(function (c) {
      var cell = self.reelSet.reels[c.reel].cellAt(c.row);
      if (cell) {
        cell.classList.add('is-near');
        self._markedCells.push(cell);
      }
    });

    badge.classList.add('is-near-miss');
    badge.style.setProperty('--badge-color', '#93a6c9');
    badge.innerHTML = '';

    var tag = document.createElement('span');
    tag.className = 'badge__tag';
    tag.textContent = 'SO CLOSE';

    var thumb = document.createElement('img');
    thumb.className = 'badge__thumb';
    thumb.src = sym.img;
    thumb.alt = sym.name;

    var text = document.createElement('span');
    text.className = 'badge__text';
    text.textContent = nm.count + '× ' + sym.short + ' from reel ' + (nm.startReel + 1);

    var note = document.createElement('span');
    note.className = 'badge__note';
    note.textContent = 'lines must start on reel 1';

    badge.appendChild(tag);
    badge.appendChild(thumb);
    badge.appendChild(text);
    badge.appendChild(note);
    badge.hidden = false;

    badge.classList.remove('is-pop');
    void badge.offsetWidth;
    badge.classList.add('is-pop');

    clearTimeout(this._nearTimer);
    this._nearTimer = setTimeout(function () {
      badge.hidden = true;
      badge.classList.remove('is-near-miss');
    }, this.turbo ? 1400 : 2800);
  };

  Game.prototype.showBadge = function (entry, multiplier, isScatter, position, shown, totalLines) {
    var sym = cfg.SYMBOLS[entry.symbolId];
    var badge = this.el.badge;
    var color = isScatter
      ? '#7de3ff'
      : cfg.LINE_COLORS[entry.lineIndex % cfg.LINE_COLORS.length];

    badge.style.setProperty('--badge-color', color);
    badge.innerHTML = '';

    var tag = document.createElement('span');
    tag.className = 'badge__tag';
    tag.textContent = isScatter ? 'SCATTER' : 'LINE ' + entry.lineNumber;

    var thumb = document.createElement('img');
    thumb.className = 'badge__thumb';
    thumb.src = sym.img;
    thumb.alt = sym.name;

    var text = document.createElement('span');
    text.className = 'badge__text';
    text.textContent = entry.count + '× ' + sym.short;

    var amount = document.createElement('span');
    amount.className = 'badge__amount';
    amount.textContent = entry.amount > 0 ? '$' + U.compact(entry.amount) : 'FREE SPINS';

    badge.appendChild(tag);
    badge.appendChild(thumb);
    badge.appendChild(text);

    /* "3/12" so the player knows how far through the wins they are, and
     * that more are coming — essential once 100 lines are in play. */
    if (shown > 1) {
      var idx = document.createElement('span');
      idx.className = 'badge__index';
      idx.textContent = position + '/' + (totalLines > shown ? totalLines : shown);
      badge.appendChild(idx);
    }

    if (multiplier > 1) {
      var mult = document.createElement('span');
      mult.className = 'badge__mult';
      mult.textContent = '×' + multiplier;
      badge.appendChild(mult);
    }

    badge.appendChild(amount);
    badge.hidden = false;

    /* Retrigger the pop animation on every cycle step. */
    badge.classList.remove('is-pop');
    void badge.offsetWidth;
    badge.classList.add('is-pop');
  };

  /* ------------------------------------------------------------------ *
   * Overlays
   * ------------------------------------------------------------------ */
  Game.prototype.showBigWin = function (amount, tier) {
    var self = this;
    var e = this.el;

    /* The tier artwork already reads "BIG WIN" / "HUGE WIN" / "MEGA WIN",
     * so the label element is only a fallback for a missing image. */
    e.bigWin.style.backgroundImage = tier.art ? 'url("' + tier.art + '")' : '';
    e.bigWin.classList.toggle('has-art', !!tier.art);
    e.bigWinLabel.textContent = tier.label;
    e.bigWinLabel.hidden = !!tier.art;

    e.bigWinValue.textContent = '0';
    e.bigWin.hidden = false;
    e.bigWin.classList.add('is-on');

    var dur = this.turbo || this.reducedMotion ? 900 : 2400;
    var start = performance.now();
    var ticks = 0;

    return new Promise(function (resolve) {
      self._bigWinResolve = resolve;

      (function step(now) {
        if (e.bigWin.hidden) return;             /* dismissed early */
        var p = U.clamp((now - start) / dur, 0, 1);
        var shown = Math.floor(amount * U.easeOutCubic(p));
        e.bigWinValue.textContent = U.compact(shown);

        var nextTick = Math.floor(p * 26);
        if (nextTick > ticks) { ticks = nextTick; self.audio.winTick(ticks); }

        if (p < 1) {
          requestAnimationFrame(step);
        } else {
          e.bigWinValue.textContent = U.compact(amount);
          self._bigWinTimer = setTimeout(function () { self.dismissBigWin(); }, 1400);
        }
      })(start);
    });
  };

  Game.prototype.dismissBigWin = function () {
    var e = this.el;
    if (e.bigWin.hidden) return;

    clearTimeout(this._bigWinTimer);
    e.bigWin.classList.remove('is-on');
    e.bigWin.hidden = true;

    var resolve = this._bigWinResolve;
    this._bigWinResolve = null;
    if (resolve) resolve();
  };

  Game.prototype.showFreeSpinsBanner = function (award, lockedWilds) {
    var self = this;
    var e = this.el;

    /* freeback.png already carries the "FREE SPINS" wordmark. */
    if (cfg.FREE_SPINS_ART) {
      e.fsBanner.style.backgroundImage = 'url("' + cfg.FREE_SPINS_ART + '")';
      e.fsBanner.classList.add('has-art');
    }

    e.fsBannerCount.textContent = String(award);
    e.fsBannerNote.hidden = !lockedWilds;
    if (lockedWilds) {
      e.fsBannerNote.textContent = lockedWilds === 1
        ? '1 WILD LOCKED FOR ' + cfg.STICKY_WILD_SPINS + ' SPINS'
        : lockedWilds + ' WILDS LOCKED FOR ' + cfg.STICKY_WILD_SPINS + ' SPINS';
    }

    e.fsBanner.hidden = false;
    e.fsBanner.classList.add('is-on');
    this.audio.fanfare();
    this.render();

    return new Promise(function (resolve) {
      setTimeout(function () {
        e.fsBanner.classList.remove('is-on');
        e.fsBanner.hidden = true;
        resolve();
      }, self.turbo ? 1200 : 2200);
    });
  };

  /* End-of-round tally: everything the free spins banked, counted up in
   * one go before it lands in the balance. */
  Game.prototype.showRoundTotal = function (amount) {
    var self = this;
    var e = this.el;

    if (cfg.FREE_SPINS_ART) {
      e.roundTotal.style.backgroundImage = 'url("' + cfg.FREE_SPINS_ART + '")';
      e.roundTotal.classList.add('has-art');
    }
    e.roundTotal.hidden = false;
    e.roundTotal.classList.add('is-on');
    this.audio.fanfare();

    var dur = this.turbo || this.reducedMotion ? 900 : 2000;
    var start = performance.now();
    var ticks = 0;

    return new Promise(function (resolve) {
      (function step(now) {
        var p = U.clamp((now - start) / dur, 0, 1);
        e.roundTotalValue.textContent = U.money(amount * U.easeOutCubic(p));

        var next = Math.floor(p * 24);
        if (next > ticks) { ticks = next; self.audio.winTick(ticks); }

        if (p < 1) {
          requestAnimationFrame(step);
        } else {
          e.roundTotalValue.textContent = U.money(amount);
          /* The round total waits for the player rather than timing out —
           * it is the payoff for the whole round, so it should not vanish
           * while they are still reading it. */
          e.roundCollect.hidden = false;
          e.roundCollect.focus();
          e.roundCollect.onclick = function () {
            e.roundCollect.onclick = null;
            e.roundCollect.hidden = true;
            e.roundTotal.classList.remove('is-on');
            e.roundTotal.hidden = true;
            self.audio.click();
            resolve();
          };
        }
      })(start);
    });
  };

  /* ------------------------------------------------------------------ *
   * Bonus pick game
   * ------------------------------------------------------------------ */
  Game.prototype.runBonusGame = function (result, bet) {
    var self = this;

    if (!this.bonusGame) {
      this.bonusGame = new NS.BonusGame(this.el.bonusLayer, cfg, this.audio);
    }

    /* Light up the seals that triggered it before the modal opens. */
    result.bonus.cells.forEach(function (c) {
      var cell = self.reelSet.reels[c.reel].cellAt(c.row);
      if (cell) { cell.classList.add('is-win', 'is-bonus'); self._markedCells.push(cell); }
    });
    this.audio.scatterHit(3);

    return new Promise(function (r) { setTimeout(r, self.turbo ? 400 : 900); })
      .then(function () { return self.bonusGame.play(bet, Math.floor(self.jackpot)); })
      .then(function (award) {
        if (self.bonusGame.jackpotWon) {
          self.jackpot = cfg.START_JACKPOT;
          self.toast('JACKPOT! $' + U.money(self.bonusGame.jackpot) + ' from the Treasury');
        }
        if (award > 0) {
          self.balance += award;
          self.lastWin = award;
          self.saveState();
          self.render();
        }
        return award;
      });
  };

  Game.prototype.toast = function (msg) {
    var e = this.el.toast;
    e.textContent = msg;
    e.hidden = false;
    e.classList.add('is-on');

    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () {
      e.classList.remove('is-on');
      e.hidden = true;
    }, 2600);
  };

  /* ------------------------------------------------------------------ *
   * Paytable
   * ------------------------------------------------------------------ */
  Game.prototype.buildPaytable = function () {
    var body = this.el.paytableBody;
    body.innerHTML = '';

    this.buildFeatureCards();

    /* One card per symbol: art, name, and the 5/4/3 payouts.  Specials
     * carry a short tag instead of a payout row — the Bonus Seal pays
     * nothing on a line, so listing 5x0 4x0 3x0 was just noise, and the
     * Winged Scarab is now the same: it awards free spins and no coin. */
    cfg.SYMBOL_LIST.forEach(function (sym) {
      var card = document.createElement('div');
      card.className = 'pay-card pay-card--' + sym.tier;

      var art = document.createElement('div');
      art.className = 'pay-card__art';
      art.style.backgroundImage = 'url("' + sym.img + '")';

      var name = document.createElement('div');
      name.className = 'pay-card__name';
      name.textContent = sym.name;

      card.appendChild(art);
      card.appendChild(name);

      if (sym.bonus) {
        card.appendChild(payTag('3 on reels 1·3·5 → Bonus'));
      } else if (sym.scatter) {
        card.appendChild(payTag('3+ anywhere → Free Spins · no coin win'));
      } else {
        var pays = document.createElement('div');
        pays.className = 'pay-card__pays';
        [5, 4, 3].forEach(function (n) {
          if (!sym.pays[n]) return;
          var line = document.createElement('span');
          line.innerHTML = '<b>' + n + '×</b>' + U.money(sym.pays[n]);
          pays.appendChild(line);
        });
        card.appendChild(pays);

        if (sym.wild) card.appendChild(payTag('Substitutes · sticky in free spins'));
      }

      body.appendChild(card);
    });

    function payTag(text) {
      var tag = document.createElement('div');
      tag.className = 'pay-card__tag';
      tag.textContent = text;
      return tag;
    }
  };

  /* Compact cards for the two features — art plus one line each. */
  Game.prototype.buildFeatureCards = function () {
    var free = this.el.freeCards;
    var bonus = this.el.bonusCards;
    if (!free || !bonus) return;

    free.innerHTML = '';
    bonus.innerHTML = '';

    function card(target, img, title, text, cls) {
      var el = document.createElement('div');
      el.className = 'info-card' + (cls ? ' ' + cls : '');

      var art = document.createElement('div');
      art.className = 'info-card__art';
      art.style.backgroundImage = 'url("' + img + '")';

      var h = document.createElement('div');
      h.className = 'info-card__title';
      h.textContent = title;

      var p = document.createElement('div');
      p.className = 'info-card__text';
      p.innerHTML = text;

      el.appendChild(art);
      el.appendChild(h);
      el.appendChild(p);
      target.appendChild(el);
      return el;
    }

    var FS = cfg.FREE_SPINS;
    card(free, cfg.SYMBOLS.scatter.img, 'Trigger',
      '<b>3</b> scarabs = <b>' + FS[3] + '</b> spins<br>4 = ' + FS[4] + ' · 5 = ' + FS[5]);
    card(free, cfg.SYMBOLS.wild.img, 'Sticky Wilds',
      'Lock for <b>' + cfg.STICKY_WILD_SPINS + '</b> spins<br>re-land: <b>×2</b> then <b>×' +
      cfg.STICKY_WILD_MAX_LEVEL + '</b>');
    card(free, 'img/menu/collect.png', 'Banked',
      'Wins pay out<br>at the end');

    var ST = cfg.BONUS.STAGES;
    card(bonus, cfg.SYMBOLS.bonus.img, 'Trigger',
      '<b>3</b> Bonus Seals<br>reels 1 · 3 · 5');
    card(bonus, ST[0].art[0], '1 · ' + ST[0].label, 'Prize · Multiplier · <b>End</b>');
    card(bonus, ST[1].art[0], '2 · ' + ST[1].label, 'Prize · Multiplier · <b>End</b>');
    card(bonus, ST[2].art[0], '3 · ' + ST[2].label,
      '<b>Jackpot</b> · End · End', 'info-card--jackpot');

    /* Miniature line diagrams.  243 of them is a wall of dots, so only
     * the first block is drawn and the rest are summarised. */
    var grid = this.el.linesGrid;
    grid.innerHTML = '';

    var SHOWN = 60;
    cfg.PAYLINES.slice(0, SHOWN).forEach(function (pattern, li) {
      var item = document.createElement('div');
      item.className = 'line-mini';
      item.style.setProperty('--mini-color', cfg.LINE_COLORS[li % cfg.LINE_COLORS.length]);

      var num = document.createElement('span');
      num.className = 'line-mini__num';
      num.textContent = li + 1;

      var cells = document.createElement('div');
      cells.className = 'line-mini__grid';

      for (var row = 0; row < cfg.ROWS; row++) {
        for (var reel = 0; reel < cfg.REELS; reel++) {
          var dot = document.createElement('span');
          dot.className = 'line-mini__cell' + (pattern[reel] === row ? ' is-on' : '');
          cells.appendChild(dot);
        }
      }

      item.appendChild(num);
      item.appendChild(cells);
      grid.appendChild(item);
    });

    if (cfg.PAYLINES.length > SHOWN) {
      var more = document.createElement('div');
      more.className = 'line-mini line-mini--more';
      more.textContent = '+' + (cfg.PAYLINES.length - SHOWN) + ' more';
      grid.appendChild(more);
    }
  };

  Game.prototype.openModal = function () {
    this.el.modal.hidden = false;
    this.el.modal.classList.add('is-on');
    this.el.modalClose.focus();
    this.audio.click();
  };

  Game.prototype.closeModal = function () {
    if (this.el.modal.hidden) return;
    this.el.modal.classList.remove('is-on');
    this.el.modal.hidden = true;
  };

  /* ================================================================== *
   * Boot
   * ================================================================== */
  function boot() {
    var bar = $('bootBar');
    var pct = $('bootPct');
    var screen = $('boot');

    var urls = cfg.SYMBOL_LIST.map(function (s) { return s.img; });
    /* The room behind the cabinet — it is the first thing on screen when
     * the boot veil lifts, so it has to be decoded by then. */
    urls.push('img/background/background.jpg');
    urls.push('img/background/bonusback.png');

    /* Celebration art must be decoded before it is needed — a big win
     * fading in while its background is still loading looks broken. */
    cfg.WIN_TIERS.forEach(function (t) { if (t.art) urls.push(t.art); });
    if (cfg.FREE_SPINS_ART) urls.push(cfg.FREE_SPINS_ART);

    /* Bonus stage art and the collect plaque — a pick tile revealing a
     * half-loaded gate would undercut the whole moment. */
    cfg.BONUS.STAGES.forEach(function (s) { s.art.forEach(function (a) { urls.push(a); }); });
    urls.push('img/menu/collect.png');

    preload(urls, function (p) {
      var v = Math.round(p * 100);
      bar.style.width = v + '%';
      pct.textContent = v + '%';
    }).then(function () {
      global.slotify = new NS.Game();
      screen.classList.add('is-done');
      setTimeout(function () { screen.hidden = true; }, 550);
    });
  }

  NS.Game = Game;
  NS.boot = boot;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
