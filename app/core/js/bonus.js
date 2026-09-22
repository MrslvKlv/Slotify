/* Slotify — Chamber of Riches: a three-stage pick bonus.
 *
 *   Stage 1  three gates    — treasure / multiplier / sealed
 *   Stage 2  three gods     — treasure / multiplier / sealed
 *   Stage 3  three scarabs  — one jackpot, two sealed
 *
 * The artwork in each stage is FIXED left to right (Anubis, Ra, Osiris in
 * stage two, for instance); only the prizes behind it are shuffled, so the
 * pick is genuinely blind while the scene stays composed.
 *
 * One sealed pick ends the run and the player keeps whatever is banked.
 * Multipliers apply to banked cash only, never to the progressive. */
(function (global) {
  'use strict';

  var NS = (global.Slotify = global.Slotify || {});
  var U = NS.util;

  function shuffle(list, rand) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  function BonusGame(root, cfg, audio) {
    this.root = root;
    this.cfg = cfg;
    this.audio = audio;
    this.rand = Math.random;
  }

  BonusGame.prototype.play = function (totalBet, jackpot) {
    var self = this;

    this.totalBet = totalBet;
    this.jackpot = jackpot || 0;
    this.jackpotWon = false;
    this.cash = 0;
    this.multiplier = 1;
    this.stageIndex = 0;
    this.ended = false;

    this.stages = this.cfg.BONUS.STAGES.map(function (stage) {
      return {
        def: stage,
        /* art stays put; the prizes move */
        prizes: shuffle(stage.prizes, self.rand),
        picked: -1
      };
    });

    this._build();

    return new Promise(function (resolve) { self._resolve = resolve; });
  };

  /* ------------------------------------------------------------------ */
  BonusGame.prototype._build = function () {
    var self = this;
    var root = this.root;

    root.innerHTML = '';
    root.hidden = false;
    root.classList.add('is-on');

    var panel = document.createElement('div');
    panel.className = 'bonus';

    var title = document.createElement('div');
    title.className = 'bonus__title';
    title.textContent = 'CHAMBER OF RICHES';

    var steps = document.createElement('div');
    steps.className = 'bonus__steps';
    this.stepEls = this.stages.map(function (s, i) {
      var dot = document.createElement('span');
      dot.className = 'bonus__step';
      dot.textContent = s.def.label;
      steps.appendChild(dot);
      return dot;
    });

    var sub = document.createElement('div');
    sub.className = 'bonus__sub';

    var board = document.createElement('div');
    board.className = 'bonus__board';

    var tally = document.createElement('div');
    tally.className = 'bonus__tally';
    tally.innerHTML =
      '<span class="bonus__tally-label">BANKED</span>' +
      '<span class="bonus__tally-value" id="bonusTally">$0</span>' +
      '<span class="bonus__tally-mult" id="bonusMult" hidden></span>';

    var footer = document.createElement('div');
    footer.className = 'bonus__footer';

    var collect = document.createElement('button');
    collect.className = 'collect-btn';
    collect.type = 'button';
    collect.hidden = true;
    collect.innerHTML = '<span class="collect-btn__label">COLLECT</span>';
    collect.addEventListener('click', function () { self._finish(); });
    footer.appendChild(collect);

    panel.appendChild(title);
    panel.appendChild(steps);
    panel.appendChild(sub);
    panel.appendChild(board);
    panel.appendChild(tally);
    panel.appendChild(footer);
    root.appendChild(panel);

    this.boardEl = board;
    this.subEl = sub;
    this.tallyEl = panel.querySelector('#bonusTally');
    this.multEl = panel.querySelector('#bonusMult');
    this.collectEl = collect;

    this._renderStage();
    this.audio.fanfare();
  };

  BonusGame.prototype._renderStage = function () {
    var self = this;
    var stage = this.stages[this.stageIndex];
    var def = stage.def;

    this.stepEls.forEach(function (el, i) {
      el.classList.toggle('is-current', i === self.stageIndex);
      el.classList.toggle('is-done', i < self.stageIndex);
    });

    this.subEl.textContent = def.hint;

    this.boardEl.innerHTML = '';
    this.boardEl.className = 'bonus__board bonus__board--stage' + (this.stageIndex + 1);

    stage.tiles = def.art.map(function (src, i) {
      var tile = document.createElement('button');
      tile.className = 'bonus-pick';
      tile.type = 'button';
      tile.setAttribute('aria-label', def.names[i] || ('Choice ' + (i + 1)));

      var art = document.createElement('span');
      art.className = 'bonus-pick__art';
      art.style.backgroundImage = 'url("' + src + '")';

      var glow = document.createElement('span');
      glow.className = 'bonus-pick__glow';

      var face = document.createElement('span');
      face.className = 'bonus-pick__face';

      tile.appendChild(art);
      tile.appendChild(glow);
      tile.appendChild(face);

      if (def.names[i]) {
        var name = document.createElement('span');
        name.className = 'bonus-pick__name';
        name.textContent = def.names[i];
        tile.appendChild(name);
      }

      tile.addEventListener('click', function () { self._pick(i); });
      self.boardEl.appendChild(tile);
      return tile;
    });
  };

  BonusGame.prototype._prizeLabel = function (p) {
    if (p.type === 'cash') return '$' + U.money(p.value * this.totalBet);
    if (p.type === 'mult') return '×' + p.value;
    if (p.type === 'jackpot') return 'JACKPOT';
    return 'SEALED';
  };

  BonusGame.prototype._pick = function (index) {
    var self = this;
    var stage = this.stages[this.stageIndex];
    if (this.ended || stage.picked >= 0) return;

    stage.picked = index;
    var prize = stage.prizes[index];

    this._reveal(stage.tiles[index], prize, true);

    if (prize.type === 'cash') {
      this.cash += prize.value * this.totalBet;
      this.audio.winTick(10 + this.stageIndex * 6);
    } else if (prize.type === 'mult') {
      this.multiplier *= prize.value;
      this.audio.stickyLock(this.stageIndex);
    } else if (prize.type === 'jackpot') {
      this.jackpotWon = true;
      this.audio.fanfare();
    } else {
      this.ended = true;
      this.audio.denied();
    }

    this._updateTally();

    /* show what was behind the other two */
    stage.prizes.forEach(function (p, i) {
      if (i === index) return;
      setTimeout(function () {
        stage.tiles[i].classList.add('is-missed');
        self._reveal(stage.tiles[i], p, false);
      }, 340 + i * 110);
    });

    var last = this.stageIndex >= this.stages.length - 1;

    setTimeout(function () {
      if (self.ended) {
        self.subEl.textContent = self.cash > 0
          ? 'Sealed — you keep what you have banked'
          : 'Sealed — the chamber keeps its secrets';
        self._offerCollect();
      } else if (last) {
        self.subEl.textContent = self.jackpotWon
          ? 'THE JACKPOT IS YOURS'
          : 'The chamber is spent';
        self._offerCollect();
      } else {
        self.stageIndex++;
        self._renderStage();
      }
    }, 1250);
  };

  BonusGame.prototype._reveal = function (tile, prize, chosen) {
    tile.classList.add('is-revealed', 'is-' + prize.type);
    if (chosen) tile.classList.add('is-chosen');
    tile.querySelector('.bonus-pick__face').textContent = this._prizeLabel(prize);
  };

  BonusGame.prototype._updateTally = function () {
    this.tallyEl.textContent = '$' + U.money(this.total());
    this.multEl.hidden = this.multiplier <= 1;
    this.multEl.textContent = '×' + this.multiplier;
  };

  /* Multiplier applies to banked cash only — never the progressive. */
  BonusGame.prototype.total = function () {
    return Math.round(this.cash * this.multiplier) +
           (this.jackpotWon ? Math.floor(this.jackpot) : 0);
  };

  BonusGame.prototype._offerCollect = function () {
    var self = this;
    setTimeout(function () {
      self.collectEl.hidden = false;
      self.collectEl.querySelector('.collect-btn__label').textContent =
        'COLLECT $' + U.money(self.total());
      self.collectEl.focus();
      if (self.total() > 0) self.audio.fanfare();
    }, 500);
  };

  BonusGame.prototype._finish = function () {
    var total = this.total();
    this.root.classList.remove('is-on');
    this.root.hidden = true;
    this.root.innerHTML = '';

    var resolve = this._resolve;
    this._resolve = null;
    if (resolve) resolve(total);
  };

  /* ------------------------------------------------------------------ *
   * Expected value of one bonus, in multiples of the total bet.
   * `jackpotInBets` lets the model price the progressive at whatever it
   * is worth relative to the current stake.
   * ------------------------------------------------------------------ */
  BonusGame.expectedValue = function (cfg, jackpotInBets) {
    var stages = cfg.BONUS.STAGES;
    var jp = jackpotInBets || 0;

    function walk(i, cash, mult, jackpot) {
      if (i >= stages.length) return cash * mult + (jackpot ? jp : 0);
      var prizes = stages[i].prizes;
      var sum = 0;
      for (var k = 0; k < prizes.length; k++) {
        var p = prizes[k];
        if (p.type === 'cash') sum += walk(i + 1, cash + p.value, mult, jackpot);
        else if (p.type === 'mult') sum += walk(i + 1, cash, mult * p.value, jackpot);
        else if (p.type === 'jackpot') sum += walk(i + 1, cash, mult, true);
        else sum += cash * mult + (jackpot ? jp : 0);   /* sealed: bank and stop */
      }
      return sum / prizes.length;
    }
    return walk(0, 0, 1, false);
  };

  /* Chance a run reaches the final stage and takes the jackpot scarab. */
  BonusGame.jackpotChance = function (cfg) {
    var stages = cfg.BONUS.STAGES;
    var reach = 1;
    for (var i = 0; i < stages.length - 1; i++) {
      var prizes = stages[i].prizes;
      var safe = prizes.filter(function (p) { return p.type !== 'end'; }).length;
      reach *= safe / prizes.length;
    }
    var last = stages[stages.length - 1].prizes;
    var jack = last.filter(function (p) { return p.type === 'jackpot'; }).length;
    return reach * (jack / last.length);
  };

  NS.BonusGame = BonusGame;
})(window);
