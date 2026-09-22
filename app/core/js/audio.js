/* Slotify — audio bus.
 *
 * Sampled sounds use plain <audio> elements so they still work from
 * file:// (fetch + decodeAudioData is blocked there by CORS).  Everything
 * else — reel stops, coin ticks, fanfares — is synthesised with WebAudio,
 * which needs no assets at all. */
(function (global) {
  'use strict';

  var NS = (global.Slotify = global.Slotify || {});

  function AudioBus() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
    this.samples = {};
    this._unlocked = false;
  }

  AudioBus.prototype.load = function (map) {
    var self = this;
    Object.keys(map).forEach(function (name) {
      var el = new Audio(map[name]);
      el.preload = 'auto';
      /* Never let a missing file break the game. */
      el.addEventListener('error', function () { self.samples[name] = null; });
      self.samples[name] = el;
    });
  };

  /* Browsers require a user gesture before audio may start. */
  AudioBus.prototype.unlock = function () {
    if (this._unlocked) return;
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (Ctx) {
      try {
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      } catch (e) {
        this.ctx = null;
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    this._unlocked = true;
  };

  AudioBus.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    if (!on) this.stopSample('spin');
    if (this.master) this.master.gain.value = on ? 0.5 : 0;
  };

  /* ---------------------------------------------------------------- *
   * Sampled playback
   * ---------------------------------------------------------------- */
  AudioBus.prototype.playSample = function (name, opts) {
    if (!this.enabled) return;
    var el = this.samples[name];
    if (!el) return;
    opts = opts || {};
    try {
      el.loop = !!opts.loop;
      el.volume = opts.volume == null ? 0.6 : opts.volume;
      el.playbackRate = opts.rate || 1;
      el.currentTime = 0;
      var p = el.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* autoplay policy, ignore */ }
  };

  AudioBus.prototype.stopSample = function (name) {
    var el = this.samples[name];
    if (!el) return;
    try { el.pause(); el.currentTime = 0; } catch (e) {}
  };

  /* Fade a looping sample out instead of cutting it dead. */
  AudioBus.prototype.fadeSample = function (name, ms) {
    var el = this.samples[name];
    if (!el || el.paused) return;
    var self = this;
    var from = el.volume;
    var start = performance.now();
    (function step(now) {
      var t = Math.min(1, (now - start) / ms);
      try { el.volume = from * (1 - t); } catch (e) {}
      if (t < 1) requestAnimationFrame(step);
      else self.stopSample(name);
    })(start);
  };

  /* ---------------------------------------------------------------- *
   * Synthesised one-shots
   * ---------------------------------------------------------------- */
  AudioBus.prototype.tone = function (o) {
    if (!this.enabled || !this.ctx) return;
    var ctx = this.ctx;
    var t0 = ctx.currentTime + (o.delay || 0);
    var dur = o.dur || 0.12;

    var osc = ctx.createOscillator();
    var gain = ctx.createGain();

    osc.type = o.type || 'triangle';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + dur);

    var peak = o.gain == null ? 0.18 : o.gain;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  };

  /* Short filtered noise burst — used for the mechanical reel stop. */
  AudioBus.prototype.noise = function (o) {
    if (!this.enabled || !this.ctx) return;
    var ctx = this.ctx;
    o = o || {};
    var dur = o.dur || 0.09;
    var frames = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 2.5);
    }

    var src = ctx.createBufferSource();
    src.buffer = buf;

    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = o.cutoff || 1400;

    var gain = ctx.createGain();
    gain.gain.value = o.gain == null ? 0.22 : o.gain;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start();
  };

  /* ---------------------------------------------------------------- *
   * Game-level cues
   * ---------------------------------------------------------------- */
  AudioBus.prototype.click = function () {
    this.tone({ freq: 880, to: 620, dur: 0.06, type: 'square', gain: 0.07 });
  };

  /* spin.wav is a 1.1s one-shot whoosh, not a seamless loop.  Looping it
   * across a ~2.6s spin replayed it about three times, which is audible
   * as a stutter — so it fires once and the reel-stop thuds carry the
   * rest of the spin. */
  AudioBus.prototype.spinStart = function () {
    this.playSample('spin', { volume: 0.4 });
    this.tone({ freq: 220, to: 660, dur: 0.22, type: 'sawtooth', gain: 0.08 });
  };

  AudioBus.prototype.spinEnd = function () {
    this.fadeSample('spin', 260);
  };

  AudioBus.prototype.reelStop = function (index) {
    this.noise({ dur: 0.10, cutoff: 900 + index * 120, gain: 0.20 });
    this.tone({ freq: 160 + index * 18, to: 90, dur: 0.11, type: 'sine', gain: 0.16 });
  };

  AudioBus.prototype.anticipation = function () {
    this.tone({ freq: 300, to: 900, dur: 0.9, type: 'sine', gain: 0.10 });
  };

  /* Rising blips while the win counter rolls up. */
  AudioBus.prototype.winTick = function (step) {
    var freq = 620 + Math.min(step, 24) * 38;
    this.tone({ freq: freq, dur: 0.05, type: 'square', gain: 0.05 });
  };

  AudioBus.prototype.lineHighlight = function () {
    this.tone({ freq: 980, to: 1320, dur: 0.09, type: 'triangle', gain: 0.07 });
  };

  AudioBus.prototype.win = function () {
    this.playSample('win', { volume: 0.5 });
  };

  AudioBus.prototype.fanfare = function () {
    var notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    for (var i = 0; i < notes.length; i++) {
      this.tone({ freq: notes[i], dur: 0.30, type: 'triangle', gain: 0.13, delay: i * 0.09 });
    }
  };

  /* Metallic "clunk" as a wild locks onto the reel. */
  AudioBus.prototype.stickyLock = function (index) {
    this.tone({ freq: 780 + (index || 0) * 60, to: 1240, dur: 0.16, type: 'square', gain: 0.10 });
    this.noise({ dur: 0.07, cutoff: 2600, gain: 0.12 });
  };

  AudioBus.prototype.scatterHit = function (n) {
    this.tone({ freq: 500 + n * 140, dur: 0.28, type: 'sine', gain: 0.16 });
  };

  AudioBus.prototype.denied = function () {
    this.tone({ freq: 200, to: 120, dur: 0.20, type: 'sawtooth', gain: 0.10 });
  };

  NS.AudioBus = AudioBus;
})(window);
