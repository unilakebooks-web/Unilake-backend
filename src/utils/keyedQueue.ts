/**
 * A tiny in-process queue per key: at most one holder of a key's slot at a time,
 * the rest wait in memory in the order they asked.
 *
 * Used for coupon checkouts. The database serialises them anyway (checkout
 * locks the coupon row), but a transaction waiting on that lock holds one of the
 * API's few database connections (about 10, shared with payment webhooks and
 * every other request). Waiting here instead keeps those connections free.
 *
 * It only orders work inside one process; across several instances the row lock
 * still guarantees correctness.
 */

const tails = new Map<string, Promise<void>>();

/**
 * Waits for the key's turn and returns a function that gives the turn up.
 * Call the returned function exactly once, in a `finally`. Calling it twice is
 * harmless.
 */
export async function acquireSlot(key: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const previous = tails.get(key) ?? Promise.resolve();
  const tail = previous.then(() => gate);
  tails.set(key, tail);

  await previous;

  return () => {
    release();
    // Forget the key once nobody is queued behind us, so the map cannot grow.
    if (tails.get(key) === tail) tails.delete(key);
  };
}

/** Number of keys that currently have a holder or a queue. For tests. */
export function pendingKeyCount(): number {
  return tails.size;
}
