export const LOGIN_IP_MAX_FAILURES = 20;
export const LOGIN_IP_WINDOW_MS = 15 * 60_000;
export const LOGIN_USER_MAX_FAILURES = 5;
export const LOGIN_USER_LOCK_MS = 15 * 60_000;

interface UnknownAttempt {
  failures: number;
  lockedUntil: number;
}

export class LoginLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly unknownUsers = new Map<string, UnknownAttempt>();

  constructor(private readonly now: () => Date) {}

  /** null when allowed, otherwise seconds until the oldest failure leaves the window. */
  blocked(ip: string): number | null {
    const now = this.now().getTime();
    const list = this.prune(ip, now);
    if (list.length < LOGIN_IP_MAX_FAILURES) return null;
    const oldest = list[0] ?? now;
    const ms = oldest + LOGIN_IP_WINDOW_MS - now;
    return Math.max(1, Math.ceil(ms / 1000));
  }

  fail(ip: string): void {
    const now = this.now().getTime();
    let list = this.hits.get(ip);
    if (!list) {
      this.evictOldest(this.hits);
      list = [];
      this.hits.set(ip, list);
    }
    this.pruneList(list, now);
    list.push(now);
  }

  /**
   * Counts one attempt for a username that is not in the database.
   * null means this attempt may run the dummy password check.
   * A number is seconds until the in-memory lock ends; do not verify.
   * The attempt that reaches the threshold still returns null and locks the name.
   */
  reserveUnknownUser(username: string): number | null {
    const now = this.now().getTime();
    let row = this.unknownUsers.get(username);
    if (row && row.lockedUntil > now) {
      return Math.max(1, Math.ceil((row.lockedUntil - now) / 1000));
    }
    if (!row) {
      this.evictOldest(this.unknownUsers);
      row = { failures: 0, lockedUntil: 0 };
      this.unknownUsers.set(username, row);
    } else if (row.lockedUntil !== 0 && row.lockedUntil <= now) {
      row.failures = 0;
      row.lockedUntil = 0;
    }
    row.failures += 1;
    if (row.failures >= LOGIN_USER_MAX_FAILURES) {
      row.failures = 0;
      row.lockedUntil = now + LOGIN_USER_LOCK_MS;
    }
    return null;
  }

  private evictOldest<T>(map: Map<string, T>): void {
    if (map.size < 10_000) return;
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }

  private prune(ip: string, now: number): number[] {
    const list = this.hits.get(ip);
    if (!list) return [];
    this.pruneList(list, now);
    if (list.length === 0) this.hits.delete(ip);
    return list;
  }

  private pruneList(list: number[], now: number): void {
    while (list.length > 0 && now - (list[0] ?? now) >= LOGIN_IP_WINDOW_MS) list.shift();
  }
}
