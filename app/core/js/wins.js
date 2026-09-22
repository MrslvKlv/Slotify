/* Slotify — payline evaluation and the win-line overlay. */
(function (global) {
  'use strict';

  var NS = (global.Slotify = global.Slotify || {});

  /* ================================================================== *
   * Evaluation
   * ================================================================== */

  /* Best paying interpretation of one payline, reading left to right.
   *
   * When the line opens with wilds there are two candidates: the wilds
   * paying as themselves, or the wilds substituting for the first real
   * symbol after them.  We score both and keep whichever pays more,
   * which is how commercial slots resolve it. */
  /* Scatter and Bonus pay from anywhere, so neither can sit inside a
   * line combination — both stop the run dead. */
  function blocks(sym) { return sym.scatter || sym.bonus; }

  function bestLineWin(ids, SYMBOLS) {
    var first = SYMBOLS[ids[0]];
    if (!first || blocks(first)) return null;

    var candidates = [];
    if (first.wild) {
      candidates.push('wild');
      for (var i = 1; i < ids.length; i++) {
        var s = SYMBOLS[ids[i]];
        if (blocks(s)) break;
        if (!s.wild) { candidates.push(ids[i]); break; }
      }
    } else {
      candidates.push(ids[0]);
    }

    var best = null;

    for (var c = 0; c < candidates.length; c++) {
      var id = candidates[c];
      var count = 0;

      for (var j = 0; j < ids.length; j++) {
        var sym = SYMBOLS[ids[j]];
        if (blocks(sym)) break;
        var matches = ids[j] === id || (sym.wild && id !== 'wild');
        if (!matches) break;
        count++;
      }

      var pay = SYMBOLS[id].pays[count] || 0;
      if (pay > 0 && (!best || pay > best.pay)) {
        best = { symbolId: id, count: count, pay: pay };
      }
    }

    return best;
  }

  /* grid[reel][row] -> symbol id
   *
   * opts.cellMultiplier(reel, row) returns the multiplier a cell carries
   * (sticky wild levels during free spins); a line pays the product of
   * the multipliers it runs through. */
  function evaluate(grid, cfg, betPerLine, activeLines, totalBet, opts) {
    var SYMBOLS = cfg.SYMBOLS;
    var cellMult = (opts && opts.cellMultiplier) || null;
    var lines = [];
    var lineTotal = 0;
    var jackpotHit = false;

    for (var li = 0; li < activeLines; li++) {
      var pattern = cfg.PAYLINES[li];

      var ids = pattern.map(function (row, reel) { return grid[reel][row]; });
      var best = bestLineWin(ids, SYMBOLS);
      if (!best) continue;

      var cells = pattern.slice(0, best.count).map(function (row, reel) {
        return { reel: reel, row: row };
      });

      var mult = 1;
      if (cellMult) {
        for (var m = 0; m < cells.length; m++) {
          mult *= cellMult(cells[m].reel, cells[m].row) || 1;
        }
      }

      var amount = best.pay * betPerLine * mult;
      lineTotal += amount;

      if (best.symbolId === 'wild' && best.count === 5) jackpotHit = true;

      lines.push({
        lineIndex: li,
        lineNumber: li + 1,
        symbolId: best.symbolId,
        count: best.count,
        amount: amount,
        multiplier: mult,
        cells: cells
      });
    }

    /* Scatters and Bonus Seals count from anywhere on the visible grid. */
    var scatterCells = [];
    var bonusCells = [];
    for (var r = 0; r < cfg.REELS; r++) {
      for (var rw = 0; rw < cfg.ROWS; rw++) {
        var s = SYMBOLS[grid[r][rw]];
        if (s.scatter) scatterCells.push({ reel: r, row: rw });
        if (s.bonus) bonusCells.push({ reel: r, row: rw });
      }
    }

    var scatterCount = scatterCells.length;
    var scatterAmount = 0;
    if (scatterCount >= 3) {
      var capped = Math.min(scatterCount, 5);
      scatterAmount = (SYMBOLS.scatter.pays[capped] || 0) * totalBet;
    }

    /* Highest single line win — drives which line the badge opens on. */
    var topLine = null;
    lines.forEach(function (l) {
      if (!topLine || l.amount > topLine.amount) topLine = l;
    });
    lines.sort(function (a, b) { return b.amount - a.amount; });

    return {
      lines: lines,
      lineTotal: lineTotal,
      scatter: {
        count: scatterCount,
        amount: scatterAmount,
        cells: scatterCells,
        triggersFreeSpins: scatterCount >= 3
      },
      bonus: {
        count: bonusCells.length,
        cells: bonusCells,
        triggers: bonusCells.length >= cfg.BONUS.TRIGGER
      },
      topLine: topLine,
      jackpotHit: jackpotHit,
      total: lineTotal + scatterAmount
    };
  }

  /* The longest run of matching symbols sitting on adjacent reels that
   * does NOT start on reel 1 — the thing that looks like a win but
   * cannot pay under left-to-right rules.  Surfacing it turns a
   * "why didn't that pay?" moment into an explanation. */
  function findNearMiss(grid, cfg, activeLines) {
    var SYMBOLS = cfg.SYMBOLS;
    var best = null;

    for (var li = 0; li < activeLines; li++) {
      var pattern = cfg.PAYLINES[li];
      var ids = pattern.map(function (row, reel) { return grid[reel][row]; });

      /* start at reel 2 (index 1); a run needs 3 reels to be interesting */
      for (var start = 1; start <= cfg.REELS - 3; start++) {
        var anchor = ids[start];
        var sym = SYMBOLS[anchor];
        if (!sym || blocks(sym) || sym.wild) continue;

        var count = 1;
        for (var i = start + 1; i < ids.length; i++) {
          var s = SYMBOLS[ids[i]];
          if (blocks(s)) break;
          if (ids[i] === anchor || s.wild) count++; else break;
        }

        if (count >= 3 && (!best || count > best.count)) {
          best = { lineIndex: li, symbolId: anchor, count: count, startReel: start, cells: [] };
          for (var c = 0; c < count; c++) {
            best.cells.push({ reel: start + c, row: pattern[start + c] });
          }
        }
      }
    }

    return best;
  }

  /* ================================================================== *
   * LineOverlay — draws paylines across the reel grid
   * ================================================================== */
  function LineOverlay(svg, reelsEl, cfg) {
    this.svg = svg;
    this.reelsEl = reelsEl;
    this.cfg = cfg;
    this.geometry = null;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  LineOverlay.prototype.measure = function () {
    var reels = this.reelsEl.querySelectorAll('.reel');
    if (!reels.length) return;

    var box = this.reelsEl.getBoundingClientRect();
    if (!box.width || !box.height) return;

    var centers = [];
    var top = 0;
    var cellH = 0;

    for (var i = 0; i < reels.length; i++) {
      var rb = reels[i].getBoundingClientRect();
      centers.push(rb.left - box.left + rb.width / 2);
      top = rb.top - box.top;
      cellH = rb.height / this.cfg.ROWS;
    }

    this.geometry = { w: box.width, h: box.height, centers: centers, top: top, cellH: cellH };
    this.svg.setAttribute('viewBox', '0 0 ' + box.width + ' ' + box.height);
  };

  LineOverlay.prototype._points = function (pattern, upTo) {
    var g = this.geometry;
    var n = upTo == null ? pattern.length : upTo;
    var pts = [];

    for (var i = 0; i < n; i++) {
      pts.push({
        x: g.centers[i],
        y: g.top + pattern[i] * g.cellH + g.cellH / 2
      });
    }
    return pts;
  };

  LineOverlay.prototype.clear = function () {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
  };

  /* mode: 'ghost' (all winning lines, faint) or 'focus' (one line, bright) */
  LineOverlay.prototype.drawLine = function (lineIndex, opts) {
    if (!this.geometry) this.measure();
    if (!this.geometry) return;

    opts = opts || {};
    var pattern = this.cfg.PAYLINES[lineIndex];
    var color = this.cfg.LINE_COLORS[lineIndex % this.cfg.LINE_COLORS.length];
    var focus = opts.mode === 'focus';
    var pts = this._points(pattern, opts.upTo);

    var g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'fx-line ' + (focus ? 'fx-line--focus' : 'fx-line--ghost'));

    /* Extend a stub past the first and last reel, the way cabinet
     * machines run their lines out to the numbered markers. */
    var first = pts[0];
    var last = pts[pts.length - 1];
    var stub = this.geometry.cellH * 0.42;

    var d = 'M ' + (first.x - stub) + ' ' + first.y;
    for (var i = 0; i < pts.length; i++) d += ' L ' + pts[i].x + ' ' + pts[i].y;
    d += ' L ' + (last.x + stub) + ' ' + last.y;

    var glow = document.createElementNS(SVG_NS, 'path');
    glow.setAttribute('d', d);
    glow.setAttribute('class', 'fx-line__glow');
    glow.setAttribute('stroke', color);

    var core = document.createElementNS(SVG_NS, 'path');
    core.setAttribute('d', d);
    core.setAttribute('class', 'fx-line__core');
    core.setAttribute('stroke', color);

    g.appendChild(glow);
    g.appendChild(core);

    if (focus) {
      /* Node markers so the eye can follow the path cell by cell. */
      pts.forEach(function (p) {
        var dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', p.x);
        dot.setAttribute('cy', p.y);
        dot.setAttribute('r', 5);
        dot.setAttribute('class', 'fx-line__node');
        dot.setAttribute('fill', color);
        g.appendChild(dot);
      });

      this._addBadge(g, first.x - stub, first.y, lineIndex + 1, color);
      this._addBadge(g, last.x + stub, last.y, lineIndex + 1, color);

      /* Animate the stroke drawing itself in. */
      var len = core.getTotalLength ? core.getTotalLength() : 0;
      if (len) {
        [core, glow].forEach(function (p) {
          p.style.strokeDasharray = len;
          p.style.strokeDashoffset = len;
          p.style.animation = 'fxDraw 420ms ease-out forwards';
        });
      }
    }

    this.svg.appendChild(g);
    return g;
  };

  LineOverlay.prototype._addBadge = function (parent, x, y, number, color) {
    var circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', 11);
    circle.setAttribute('class', 'fx-line__badge');
    circle.setAttribute('fill', color);

    var text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', y);
    text.setAttribute('class', 'fx-line__badge-text');
    text.textContent = String(number);

    parent.appendChild(circle);
    parent.appendChild(text);
  };

  LineOverlay.prototype.drawAll = function (lineIndices) {
    var self = this;
    this.clear();
    lineIndices.forEach(function (i) { self.drawLine(i, { mode: 'ghost' }); });
  };

  LineOverlay.prototype.focusLine = function (win) {
    this.clear();
    this.drawLine(win.lineIndex, { mode: 'focus', upTo: win.count });
  };

  NS.wins = { evaluate: evaluate, bestLineWin: bestLineWin, findNearMiss: findNearMiss };
  NS.LineOverlay = LineOverlay;
})(window);
