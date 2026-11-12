// In-memory rate limits per client address and for the whole server. On a serverless host each instance keeps
// its own counts, so the hard ceiling on spend is the prepaid credit on the NEAR AI Cloud account.
import { HttpError } from './errors.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export class RateLimiter {
  constructor({ perHour, perDay, globalPerDay }, now = () => Date.now()) {
    this.limits = { perHour, perDay, globalPerDay };
    this.now = now;
    this.byIp = new Map();
    this.global = [];
  }

  take(ip) {
    const t = this.now();
    const prune = (list) => list.filter((x) => t - x < DAY);
    this.global = prune(this.global);
    const mine = prune(this.byIp.get(ip) || []);
    if (this.global.length >= this.limits.globalPerDay) throw new HttpError(429, 'busy_today', 'The demo has reached its limit for today. Run it yourself with your own key (see the README).');
    if (mine.length >= this.limits.perDay) throw new HttpError(429, 'limit_day', 'You have reached today\'s limit for this demo.');
    if (mine.filter((x) => t - x < HOUR).length >= this.limits.perHour) throw new HttpError(429, 'limit_hour', 'Too many requests this hour; try again later.');
    mine.push(t);
    this.global.push(t);
    this.byIp.set(ip, mine);
    if (this.byIp.size > 50_000) this.byIp.clear();
  }
}
