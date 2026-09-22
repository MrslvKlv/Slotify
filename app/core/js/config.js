/* Slotify — configuration, maths helpers and reel strips.
 * Classic script (no modules) so the game runs straight from file:// . */
(function (global) {
  'use strict';

  var NS = (global.Slotify = global.Slotify || {});

  /* ------------------------------------------------------------------ *
   * Small maths / easing helpers used by the reel engine
   * ------------------------------------------------------------------ */
  var util = {
    clamp: function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); },
    lerp: function (a, b, t) { return a + (b - a) * t; },

    easeOutCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    easeOutQuart: function (t) { return 1 - Math.pow(1 - t, 4); },
    easeInQuad: function (t) { return t * t; },
    easeInOutQuad: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },

    /* Deterministic PRNG so reel strips are identical on every load. */
    mulberry32: function (seed) {
      var a = seed >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        var t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },

    money: function (n) {
      return Math.round(n).toLocaleString('en-US');
    },

    /* Same as `money` up to 99,999,999, then abbreviated.
     *
     * The cabinet meters are painted windows — the balance, jackpot and
     * win readouts have a fixed width in the artwork, and a grouped
     * nine-digit number overflows it.  100,000,000 becomes "100M";
     * anything the window can still hold stays a real number so the
     * player can read it to the credit.
     *
     * Scaled values are truncated, never rounded, so a figure can never
     * be shown as the unit above it (999,999,999 reads "999M", not
     * "1.00B").  Collection screens — the bonus chamber and the
     * end-of-round tally — deliberately keep `money`: those are the
     * payout moments, and they are laid out to fit the full figure. */
    compact: function (n) {
      var v = Math.round(n);
      var abs = Math.abs(v);
      if (abs < 1e8) return v.toLocaleString('en-US');

      var UNITS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']];
      for (var i = 0; i < UNITS.length; i++) {
        if (abs < UNITS[i][0]) continue;

        var scaled = v / UNITS[i][0];
        var mag = Math.abs(scaled);
        var digits = mag >= 100 ? 0 : (mag >= 10 ? 1 : 2);
        var f = Math.pow(10, digits);
        var cut = (scaled < 0 ? Math.ceil(scaled * f) : Math.floor(scaled * f)) / f;
        return cut.toFixed(digits) + UNITS[i][1];
      }
      return v.toLocaleString('en-US');
    },

    prefersReducedMotion: function () {
      return global.matchMedia &&
        global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
  };

  /* ------------------------------------------------------------------ *
   * Symbols.  `pays` is indexed by match count, so pays[3] is the payout
   * for three of a kind expressed as a multiple of the per-line bet.
   *
   * These values were tuned, not guessed: simulated over 400,000 spins
   * against the reel strips below — including the sticky-wild free-spins
   * round and the bonus pick game — for ~96% RTP.
   *
   * Since then every line-combination payout (wild and the eight regular
   * symbols) has been cut twice, each time scaled and rounded to whole
   * numbers: first by 20%, taking base-game line RTP from ~76.9% to
   * ~61.0%, then by a further 15%, taking it to ~52.3% (300k-spin sample,
   * same result at 20 and at 243 lines).
   *
   * That second cut measures ~14.2% in RTP rather than 15%, and the
   * rounding is why: the cheap symbols are also the most frequent, and
   * 10 -> 9 and 8 -> 7 are the nearest whole numbers to 85% but the
   * coarsest — dropping them to 8 and 6 would be -20% and -25%, further
   * off target than the shortfall.  Anyone wanting a true 15% has to
   * leave integers behind, or re-tune the reel weights instead.
   *
   * The full three-way budget (free round and bonus included) has NOT
   * been re-simulated since either cut, so the 96% figure above no
   * longer holds — treat it as history.
   *
   * The scatter now pays nothing in coin: three or more Winged Scarabs
   * award free spins and only free spins.  Its old 19/85/345 row is
   * gone, so `pays` is all zeroes and wins.evaluate contributes 0 for
   * it — the trigger is still detected from the symbol count, not the
   * payout, so nothing downstream depends on those numbers.
   *
   * Feature frequency, paytable and bonus prizes are ONE budget.  Making
   * the free round and the bonus ~3x more likely took ~35% out of the
   * paytable and ~45% out of the bonus prizes to stay at 96%.  Change any
   * one of the three and the other two need re-simulating.
   * ------------------------------------------------------------------ */
  /* Names describe the actual artwork, which the original filenames do
   * not — img/reels/cat.jpg is a jackal-headed gate, eye.jpg is the Eye
   * of Horus, anubis.jpg is an amulet, and so on.  Ids keep the old
   * filenames so the art and the tuned weights stay matched up. */
  var SYMBOL_LIST = [
    { id: 'wild',    name: 'Cleopatra',      short: 'WILD',    img: 'img/reels/wild.png',    wild: true,    tier: 'special', pays: [0, 0, 0, 58, 279, 1108] },
    { id: 'scatter', name: 'Winged Scarab',  short: 'SCATTER', img: 'img/reels/scatter.png', scatter: true, tier: 'special', pays: [0, 0, 0,  0,   0,    0] },
    { id: 'bonus',   name: 'Bonus Seal',     short: 'BONUS',   img: 'img/reels/bonus.png',   bonus: true,   tier: 'special', pays: [0, 0, 0,  0,   0,    0] },
    { id: 'cat',     name: 'Anubis Gate',    short: 'GATE',    img: 'img/reels/cat.jpg',     tier: 'high', pays: [0, 0, 0, 26, 133, 554] },
    { id: 'diamond', name: 'Radiant Ankh',   short: 'ANKH',    img: 'img/reels/diamond.jpg', tier: 'high', pays: [0, 0, 0, 22,  90, 357] },
    { id: 'star',    name: 'Obelisk of Ra',  short: 'OBELISK', img: 'img/reels/star.jpg',    tier: 'high', pays: [0, 0, 0, 19,  61, 279] },
    { id: 'mask',    name: 'Royal Sceptre',  short: 'SCEPTRE', img: 'img/reels/mask.jpg',    tier: 'mid',  pays: [0, 0, 0, 13,  56, 211] },
    { id: 'tent',    name: "Pharaoh's Mask", short: 'MASK',    img: 'img/reels/tent.jpg',    tier: 'mid',  pays: [0, 0, 0, 12,  41, 160] },
    { id: 'statue',  name: 'Golden Shrine',  short: 'SHRINE',  img: 'img/reels/statue.jpg',  tier: 'mid',  pays: [0, 0, 0,  9,  32, 138] },
    { id: 'anubis',  name: 'Sacred Amulet',  short: 'AMULET',  img: 'img/reels/anubis.jpg',  tier: 'low',  pays: [0, 0, 0,  7,  26, 111] },
    { id: 'eye',     name: 'Eye of Horus',   short: 'HORUS',   img: 'img/reels/eye.jpg',     tier: 'low',  pays: [0, 0, 0,  7,  22,  85] }
  ];

  var SYMBOLS = {};
  SYMBOL_LIST.forEach(function (s) { SYMBOLS[s.id] = s; });

  /* ------------------------------------------------------------------ *
   * Paylines.  Each entry lists the row index (0 = top, 2 = bottom)
   * touched on reels 1..5, so there are 3^5 = 243 possible shapes.
   *
   * The 20 classic shapes come first and keep their familiar numbers;
   * the rest are filled in smoothest-first, so low line numbers are the
   * gentle zig-zags and the steep shapes land at the end.
   * ------------------------------------------------------------------ */
  /* 243 = every possible path through the 5x3 grid (3^5), which is the
   * same thing as "243 ways to win".  Stopping at 100 sounds bigger than
   * it is: only 99 of the 243 shapes never jump a row, so a 100-line set
   * is all the gentle ones plus one, and boards whose only match needs a
   * two-row step still pay nothing.  RTP measures the same at every line
   * count — but only because wins.evaluate walks each of these paths
   * independently, so one formation on reels 1..k is paid once per tail
   * path sharing its prefix (3^(5-k) times on the full set).  That is a
   * known bug, not a property of the maths: dedupe the paid lines and RTP
   * drops from ~77% at 20 lines to ~24% at 243.  Whoever fixes it has to
   * move to real ways-to-win (or a genuinely distinct payline set) rather
   * than just dropping the duplicates, or the line selector becomes a
   * straight RTP lever. */
  var PAYLINE_COUNT = 243;

  var CLASSIC_LINES = [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [2, 2, 2, 2, 2],
    [0, 1, 2, 1, 0],
    [2, 1, 0, 1, 2],
    [0, 0, 1, 2, 2],
    [2, 2, 1, 0, 0],
    [1, 0, 0, 0, 1],
    [1, 2, 2, 2, 1],
    [0, 1, 1, 1, 0],
    [2, 1, 1, 1, 2],
    [1, 2, 1, 0, 1],
    [1, 0, 1, 2, 1],
    [0, 0, 1, 0, 0],
    [2, 2, 1, 2, 2],
    [1, 1, 0, 1, 1],
    [1, 1, 2, 1, 1],
    [0, 1, 0, 1, 0],
    [2, 1, 2, 1, 2],
    [0, 2, 0, 2, 0]
  ];

  /* Lower is smoother: two-row jumps cost most, then total travel, then
   * how often the line changes direction. */
  function shapeCost(p) {
    var jump = 0, steep = 0, turns = 0, prevDir = 0;
    for (var i = 1; i < p.length; i++) {
      var d = p[i] - p[i - 1];
      jump += Math.abs(d);
      if (Math.abs(d) > 1) steep++;
      var dir = d === 0 ? 0 : (d > 0 ? 1 : -1);
      if (dir !== 0) {
        if (prevDir !== 0 && dir !== prevDir) turns++;
        prevDir = dir;
      }
    }
    return steep * 100 + jump * 10 + turns;
  }

  function buildPaylines(count) {
    var seen = {};
    var out = [];

    CLASSIC_LINES.forEach(function (p) {
      var key = p.join('');
      if (!seen[key]) { seen[key] = true; out.push(p.slice()); }
    });

    var all = [];
    for (var a = 0; a < 3; a++)
      for (var b = 0; b < 3; b++)
        for (var c = 0; c < 3; c++)
          for (var d = 0; d < 3; d++)
            for (var e = 0; e < 3; e++) all.push([a, b, c, d, e]);

    all.sort(function (x, y) {
      var cx = shapeCost(x), cy = shapeCost(y);
      if (cx !== cy) return cx - cy;
      return x.join('') < y.join('') ? -1 : 1;   /* deterministic tie-break */
    });

    for (var i = 0; i < all.length && out.length < count; i++) {
      var k = all[i].join('');
      if (!seen[k]) { seen[k] = true; out.push(all[i]); }
    }

    return out;
  }

  var PAYLINES = buildPaylines(PAYLINE_COUNT);

  /* The first 20 keep their hand-picked hues; the rest walk the colour
   * wheel by the golden angle so neighbouring line numbers never share
   * a colour when several light up at once. */
  var LINE_COLORS = [
    '#ffd24a', '#4ad9ff', '#ff6b9d', '#7dff6b', '#ff9147',
    '#c48bff', '#4affc4', '#ff5a5a', '#8fb4ff', '#ffe97a',
    '#31e0a4', '#ff87e0', '#a0ff4a', '#5ab0ff', '#ffb347',
    '#e07bff', '#4affe9', '#ff7a6b', '#b6ff8f', '#ffc94a'
  ];
  while (LINE_COLORS.length < PAYLINES.length) {
    var n = LINE_COLORS.length;
    LINE_COLORS.push('hsl(' + ((n * 137.508) % 360).toFixed(1) + ' ' +
      (72 + (n % 3) * 8) + '% ' + (62 + (n % 4) * 4) + '%)');
  }

  var LINES_OPTIONS = [1, 20, 50, 100, PAYLINE_COUNT];
  /* No real ceiling here — the old 100 cap was arbitrary.  The ladder
   * runs 1-2-5 per decade so each press is a meaningful jump, and MAX BET
   * picks the largest step the balance can actually cover. */
  var BET_STEPS = [
    1, 2, 5, 10, 20, 50, 100, 200, 500,
    1000, 2000, 5000, 10000, 20000, 50000, 100000
  ];

  /* ------------------------------------------------------------------ *
   * Reel strips.  Built from per-reel weights then spaced out so the
   * same symbol never sits next to itself and specials stay scarce.
   * ------------------------------------------------------------------ */
  var STRIP_LENGTH = 48;

  /* Rows are built to sum to STRIP_LENGTH.  `eye` soaks up the slack so
   * a tweak to any special weight stays balanced automatically.
   *
   * - scatter sits at full weight on only two reels, which holds the
   *   10/15/30 free-spin round to roughly 1 in 190 spins;
   * - bonus appears on reels 1, 3 and 5 only, so the pick game needs one
   *   on each of those three reels (the classic trigger);
   * - the free-spin strips carry far more wilds and no bonus symbols. */
  function weightsFor(opts) {
    var w = {
      anubis: 7, statue: 7, tent: 6, mask: 5, star: 5, diamond: 4, cat: 3,
      wild: opts.wild, scatter: opts.scatter
    };
    if (opts.bonus) w.bonus = opts.bonus;

    var used = 0;
    Object.keys(w).forEach(function (k) { used += w[k]; });
    w.eye = STRIP_LENGTH - used;
    return w;
  }

  var BASE_WILD    = [1, 2, 2, 2, 1];

  /* Feature frequency is the single biggest lever on how the game feels.
   * At the old weights the free round landed 1 in 183 spins and the bonus
   * 1 in 515 — commercially normal, but that is 12 and 35 minutes of
   * spinning, so most sessions never saw either.  Both are now roughly
   * three times more likely; the paytable and bonus prizes were scaled
   * down to pay for it (see the header note). */
  /* Reel weights are integers on a 48-symbol strip, so the trigger rate
   * only comes in steps.  These are the closest available to the target
   * of 1 in 128 free spins and 1 in 256 bonuses: the bonus needs a seal
   * on each of reels 1, 3 and 5, and the options either side of this one
   * are 1 in 152 (3/3/3) and 1 in 341 (3/2/2). */
  var BASE_SCATTER = [1, 1, 2, 2, 2];   /* -> free spins 1 in ~124 */
  var BASE_BONUS   = [3, 0, 3, 0, 2];   /* -> bonus      1 in ~231 */

  /* Free spins run hotter on purpose: the round is rare, so it should
   * pay off.  More wilds means more sticky wilds, which stack into
   * multipliers — the two boosts compound, so this is the single most
   * RTP-sensitive number in the file. */
  var FREE_WILD    = [2, 2, 2, 2, 2];
  var FREE_SCATTER = [1, 1, 1, 1, 1];

  var REEL_WEIGHTS = BASE_WILD.map(function (wild, i) {
    return weightsFor({ wild: wild, scatter: BASE_SCATTER[i], bonus: BASE_BONUS[i] });
  });

  var FREE_REEL_WEIGHTS = FREE_WILD.map(function (wild, i) {
    return weightsFor({ wild: wild, scatter: FREE_SCATTER[i], bonus: 0 });
  });

  /* How many neighbours on either side must differ from a given symbol. */
  var MIN_GAP = { scatter: 6, bonus: 6, wild: 3, cat: 2, diamond: 2 };

  function buildStrip(weights, length, seed) {
    var rand = util.mulberry32(seed);
    var pool = [];

    Object.keys(weights).forEach(function (id) {
      for (var i = 0; i < weights[id]; i++) pool.push(id);
    });
    while (pool.length < length) pool.push('eye');
    pool.length = length;

    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }

    /* Relaxation passes: swap offenders to random slots until spacing holds. */
    for (var pass = 0; pass < 200; pass++) {
      var clean = true;
      for (var k = 0; k < pool.length; k++) {
        var gap = MIN_GAP[pool[k]] || 1;
        for (var d = 1; d <= gap; d++) {
          if (pool[(k + d) % pool.length] === pool[k]) {
            var s = Math.floor(rand() * pool.length);
            var t = pool[k]; pool[k] = pool[s]; pool[s] = t;
            clean = false;
            break;
          }
        }
      }
      if (clean) break;
    }

    return pool;
  }

  var STRIPS = REEL_WEIGHTS.map(function (w, i) {
    return buildStrip(w, STRIP_LENGTH, 0x51075 + i * 9781);
  });

  /* Same length as the base strips so a reel can swap between them
   * mid-session without its landing index going out of range. */
  var FREE_STRIPS = FREE_REEL_WEIGHTS.map(function (w, i) {
    return buildStrip(w, STRIP_LENGTH, 0x9F2C1 + i * 6421);
  });

  /* ------------------------------------------------------------------ */
  NS.config = {
    REELS: 5,
    ROWS: 3,

    SYMBOLS: SYMBOLS,
    SYMBOL_LIST: SYMBOL_LIST,
    PAYLINES: PAYLINES,
    LINE_COLORS: LINE_COLORS,
    LINES_OPTIONS: LINES_OPTIONS,
    BET_STEPS: BET_STEPS,
    STRIPS: STRIPS,
    FREE_STRIPS: FREE_STRIPS,

    /* At 243 lines the cheapest spin costs 243x the per-line bet, so the
     * starting bankroll is scaled to match (~400 spins at minimum bet). */
    START_BALANCE: 100000,
    START_JACKPOT: 250000,
    JACKPOT_RATE: 0.3,          /* share of each wager fed to the jackpot */
    TOP_UP: 25000000,

    /* 10 spins for 3 scatters, x1.5 for 4, x3 for 5.
     *
     * Cut ~30% from the old 15/22/45.  Taken off the base award rather
     * than the ladder, so the x1.5 / x3 shape survives and all three
     * numbers stay round: an exact 30% would have been 10.5/15.4/31.5.
     * Against the old awards that is -33%/-32%/-33%.
     *
     * Free-spin RTP moves with this almost one-for-one — sticky wilds
     * compound across a round, so a shorter round is worth less than
     * proportionally less.  Combined with the scatter losing its coin
     * payout, the paytable and bonus prizes are now budgeted well under
     * where they were; re-simulate before treating any RTP figure in
     * this file as current. */
    FREE_SPINS: { 3: 10, 4: 15, 5: 30 },

    /* Sticky wilds replaced the flat free-spin multiplier — they are
     * worth far more than x2 on their own (see the header note). */
    FREE_SPIN_MULTIPLIER: 1,
    STICKY_WILD_SPINS: 3,

    /* A wild landing on a cell that already holds one renews its life and
     * raises its level.  A line's payout is multiplied by the product of
     * the levels of the sticky wilds it runs through, so two level-3
     * wilds on one line pay 9x.
     *
     * The cap matters far more than it looks: across 243 lines the
     * products compound, and raising it to 6 with heavier free-spin
     * strips took RTP to 397%. */
    STICKY_WILD_MAX_LEVEL: 3,

    /* --- Bonus pick game ------------------------------------------- *
     * Three Bonus Seals (reels 1, 3 and 5) open a three-lane pick.  The
     * player takes one card per lane; cash values are multiples of the
     * TOTAL bet.  Each stage shows three fixed pieces of art in a fixed
     * left-to-right order; only the prizes behind them are shuffled.
     *
     * Stage 3 is all or nothing: one scarab carries the jackpot, the
     * other two end the run.  Multipliers apply to the banked cash only
     * — letting them multiply the progressive as well roughly triples
     * the bonus's entire RTP contribution. */
    BONUS: {
      TRIGGER: 3,

      /* The Treasury occasionally hides a JACKPOT door in place of its
       * multiplier.  It has to stay scarce: the progressive is worth
       * 1000x+ the total bet, so a door in every bonus would be ~120%
       * RTP on its own.  At 1 in 12 bonuses it works out to a jackpot
       * roughly every 9,000 spins. */
      STAGES: [
        {
          label: 'The Gates',
          hint: 'Three gates. One hides treasure, one a multiplier, one is sealed.',
          art: ['img/bonus/gate1.png', 'img/bonus/gate2.png', 'img/bonus/gate3.png'],
          names: ['', '', ''],
          prizes: [{ type: 'cash', value: 15 }, { type: 'mult', value: 2 }, { type: 'end' }]
        },
        {
          label: 'The Gods',
          hint: 'Anubis, Ra and Osiris — choose whose favour you carry.',
          /* ra/osiris were exported 24-bit with the transparency
           * checkerboard flattened in; img/bonus/cut holds versions with
           * that background keyed out. Originals are untouched. */
          art: ['img/bonus/anubis.png', 'img/bonus/cut/ra.png', 'img/bonus/cut/osiris.png'],
          names: ['Anubis', 'Ra', 'Osiris'],
          prizes: [{ type: 'cash', value: 40 }, { type: 'mult', value: 3 }, { type: 'end' }]
        },
        {
          label: 'The Scarabs',
          hint: 'One carries the Jackpot. The other two end everything.',
          art: ['img/bonus/cut/scarrabanubis.png', 'img/bonus/cut/scarrabra.png', 'img/bonus/cut/scarrabosiris.png'],
          names: ['', '', ''],
          prizes: [{ type: 'jackpot' }, { type: 'end' }, { type: 'end' }]
        }
      ]
    },

    /* Win tiers, expressed as multiples of the total bet.  Each has its
     * own artwork with the wording already painted in, so the overlay
     * renders the picture and the amount only — no text label. */
    WIN_TIERS: [
      { at: 50, label: 'MEGA WIN', art: 'img/background/megaback.png' },
      { at: 25, label: 'HUGE WIN', art: 'img/background/hugeback.png' },
      { at: 12, label: 'BIG WIN',  art: 'img/background/bigback.png' }
    ],

    FREE_SPINS_ART: 'img/background/freeback.png',

    STORAGE_KEY: 'slotify.state.v1'
  };

  NS.util = util;
})(window);
