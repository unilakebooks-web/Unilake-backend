// A fixed amount of memory that concurrent requests reserve before they hold data (feature 14, share images).
// A request that does not fit waits in line; if it waits too long, or its client goes away, it leaves the line.

export type Release = () => void;

interface Waiter {
  bytes: number;
  resolve: (release: Release | null) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class ByteBudget {
  private used = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly total: number) {}

  /** Bytes currently reserved (read by the tests). */
  get inUse(): number {
    return this.used;
  }

  /** Requests waiting for room (read by the tests). */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Reserves `bytes`. Resolves with a release function (safe to call more than once), or null when there was
   * no room within `waitMs` or `signal` fired first. A request bigger than the whole budget is never granted.
   */
  acquire(
    bytes: number,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<Release | null> {
    if (bytes > this.total || signal?.aborted) return Promise.resolve(null);
    if (this.waiters.length === 0 && this.used + bytes <= this.total) {
      return Promise.resolve(this.grant(bytes));
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        bytes,
        resolve,
        signal,
        timer: setTimeout(() => this.leave(waiter), waitMs),
      };
      if (signal) {
        waiter.onAbort = () => this.leave(waiter);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private grant(bytes: number): Release {
    this.used += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= bytes;
      this.serve();
    };
  }

  private leave(waiter: Waiter) {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) return;
    this.waiters.splice(index, 1);
    this.finish(waiter);
    waiter.resolve(null);
    this.serve();
  }

  private finish(waiter: Waiter) {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  /** Grants the line in order while the next request fits. */
  private serve() {
    for (
      let next = this.waiters[0];
      next && this.used + next.bytes <= this.total;
      next = this.waiters[0]
    ) {
      this.waiters.shift();
      this.finish(next);
      next.resolve(this.grant(next.bytes));
    }
  }
}
