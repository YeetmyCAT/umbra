// Simulation clock shared by every view: real time, paused, or running at any rate (also backwards).
export const RATES = [-86400, -18000, -3600, -600, -60, -10, -1, -0.25, 0, 0.25, 1, 10, 60, 600, 3600, 18000, 86400];
// The clock runs from the start of 1958 (the oldest object still in orbit, Vanguard 1, flew in March 1958) to 10 years
// from today; at either end it stops.
export const T_MIN = Date.UTC(1958, 0, 1), T_MAX = Date.now() + 10 * 365.25 * 864e5;
const lim = ms => Math.max(T_MIN, Math.min(T_MAX, ms));
export class Clock {
  constructor() { this.base = Date.now(); this.at = performance.now(); this.rate = 1; this.listeners = []; }
  now() {
    const t = this.base + (performance.now() - this.at) * this.rate;
    if (t >= T_MIN && t <= T_MAX) return t;
    this.base = lim(t); this.at = performance.now(); this.rate = 0; return this.base;
  }
  set(ms) { this.base = lim(ms); this.at = performance.now(); this.jumped = true; this.emit(); }
  setRate(r) { this.base = this.now(); this.at = performance.now(); this.rate = r; this.emit(); }
  live() { return this.rate === 1 && Math.abs(this.now() - Date.now()) < 2000; }
  toNow() { this.base = Date.now(); this.at = performance.now(); this.rate = 1; this.jumped = true; this.emit(); }
  step(dir) { const i = RATES.indexOf(this.rate), k = i < 0 ? RATES.indexOf(1) : Math.max(0, Math.min(RATES.length - 1, i + dir)); this.setRate(RATES[k]); }
  on(f) { this.listeners.push(f); }
  emit() { for (const f of this.listeners) f(this); }
}
export function rateLabel(r) {
  if (r === 0) return 'Paused'; if (r === 1) return 'Real time';
  const a = Math.abs(r), s = r < 0 ? '−' : '';
  return s + (a >= 86400 ? a / 86400 + ' day/s' : a >= 3600 ? a / 3600 + ' h/s' : a >= 60 ? a / 60 + ' min/s' : a + '×');
}
