import { describe, it, expect } from "vitest";
import { ByteBudget } from "../../src/utils/byteBudget.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ByteBudget", () => {
  it("grants within the budget and counts the bytes in use", async () => {
    const b = new ByteBudget(100);
    const a = await b.acquire(60, 50);
    expect(a).toBeTypeOf("function");
    expect(b.inUse).toBe(60);
    const c = await b.acquire(40, 50);
    expect(b.inUse).toBe(100);
    a!();
    c!();
    expect(b.inUse).toBe(0);
  });

  it("release is idempotent", async () => {
    const b = new ByteBudget(100);
    const r = (await b.acquire(70, 50))!;
    r();
    r();
    r();
    expect(b.inUse).toBe(0);
    const again = await b.acquire(100, 50);
    expect(again).toBeTypeOf("function");
  });

  it("makes a request wait, serves it in order when room appears, and gives null after the wait", async () => {
    const b = new ByteBudget(100);
    const first = (await b.acquire(80, 50))!;
    const waiting = b.acquire(50, 1000);
    const late = b.acquire(10, 20); // fits right now but must queue behind the first waiter
    expect(b.waiting).toBe(2);
    await tick();
    expect(await late).toBeNull(); // timed out, left the line
    first();
    const granted = await waiting;
    expect(granted).toBeTypeOf("function");
    expect(b.inUse).toBe(50);
    expect(b.waiting).toBe(0);
    granted!();
    expect(b.inUse).toBe(0);
  });

  it("removes a waiter whose client goes away, so it never holds a slot", async () => {
    const b = new ByteBudget(100);
    const held = (await b.acquire(100, 50))!;
    const controller = new AbortController();
    const waiting = b.acquire(10, 1000, controller.signal);
    expect(b.waiting).toBe(1);
    controller.abort();
    expect(await waiting).toBeNull();
    expect(b.waiting).toBe(0);
    held();
    expect(b.inUse).toBe(0);
    // the aborted waiter did not keep a reservation
    expect(await b.acquire(100, 10)).toBeTypeOf("function");
  });

  it("gives null at once when the signal is already aborted or the request is bigger than the budget", async () => {
    const b = new ByteBudget(100);
    const controller = new AbortController();
    controller.abort();
    expect(await b.acquire(10, 50, controller.signal)).toBeNull();
    expect(await b.acquire(101, 50)).toBeNull();
    expect(b.inUse).toBe(0);
  });

  it("many slow holders never push the use over the budget", async () => {
    const b = new ByteBudget(1000);
    let peak = 0;
    const runs = Array.from({ length: 200 }, async () => {
      const r = await b.acquire(100, 5000);
      if (!r) return;
      peak = Math.max(peak, b.inUse);
      await new Promise((res) => setTimeout(res, Math.random() * 5));
      r();
    });
    await Promise.all(runs);
    expect(peak).toBeLessThanOrEqual(1000);
    expect(b.inUse).toBe(0);
    expect(b.waiting).toBe(0);
  });
});
