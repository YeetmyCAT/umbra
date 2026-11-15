// Simulation clock shared by every view: real time, paused, or running at any rate (also backwards).
export const RATES = [-86400, -18000, -3600, -600, -60, -10, -1, 0, 0.25, 1, 10, 60, 600, 3600, 18000, 86400];
export class Clock {
  constructor() { this.base = Date.now(); this.at = performance.now(); this.rate = 1; this.listeners = []; }
  now() { return this.base + (performance.now() - this.at) * this.rate; }
  set(ms) { this.base = ms; this.at = performance.now(); this.jumped = true; this.emit(); }
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
