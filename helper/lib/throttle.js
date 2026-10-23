'use strict';
// Adaptive connection limit. Starts low, adds connections while throughput grows,
// halves the limit when the server answers with errors or junk (rate limiting).

class AdaptiveLimiter {
  constructor({ start = 4, min = 2, max = 16, step = 2, windowMs = 4000 } = {}) {
    this.limit = start;
    this.min = min;
    this.max = max;
    this.step = step;
    this.windowMs = windowMs;
    this.active = 0;
    this.waiters = [];
    this.samples = []; // [time, bytes]
    this.lastAdjust = Date.now();
    this.bestRate = 0;
    this.grewAt = 0; // limit before the last increase (0: none pending)
    this.holdUntil = 0;
    this.peak = start;
  }

  async acquire(signal) {
    while (this.active >= this.limit) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      await new Promise(r => this.waiters.push(r));
    }
    this.active++;
  }

  release() {
    this.active--;
    this.wake();
  }

  wake() {
    while (this.waiters.length && this.active + this.waiters.length > 0 && this.active < this.limit) {
      const w = this.waiters.shift();
      w();
      if (this.active + 1 >= this.limit) break;
    }
  }

  // Bytes per second over the sliding window.
  rate(now = Date.now()) {
    while (this.samples.length && now - this.samples[0][0] > this.windowMs) this.samples.shift();
    if (!this.samples.length) return 0;
    const sum = this.samples.reduce((t, s) => t + s[1], 0);
    const span = Math.max(1000, now - this.samples[0][0]);
    return (sum / span) * 1000;
  }

  success(bytes, now = Date.now()) {
    this.samples.push([now, bytes]);
    if (now - this.lastAdjust < this.windowMs || now < this.holdUntil) return;
    const r = this.rate(now);
    this.lastAdjust = now;
    if (this.grewAt) {
      // Did the last increase help? Keep it only for a clear gain.
      if (r < this.bestRate * 1.08) {
        this.limit = this.grewAt;
        this.holdUntil = now + 30000; // stable for a while, then probe again
      } else {
        this.bestRate = r;
      }
      this.grewAt = 0;
    } else if (this.limit < this.max) {
      this.bestRate = Math.max(this.bestRate, r);
      this.grewAt = this.limit;
      this.limit = Math.min(this.max, this.limit + this.step);
      this.peak = Math.max(this.peak, this.limit);
      this.wake();
    }
  }

  failure(now = Date.now()) {
    this.limit = Math.max(this.min, Math.ceil(this.limit / 2));
    this.grewAt = 0;
    this.bestRate = 0;
    this.holdUntil = now + 15000;
    this.lastAdjust = now;
  }
}

module.exports = { AdaptiveLimiter };
