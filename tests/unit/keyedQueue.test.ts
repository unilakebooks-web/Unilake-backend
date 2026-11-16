import { describe, it, expect } from "vitest";
import { acquireSlot, pendingKeyCount } from "../../src/utils/keyedQueue.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("acquireSlot", () => {
  it("lets one holder through immediately", async () => {
    const release = await acquireSlot("solo");
    release();
    expect(pendingKeyCount()).toBe(0);
  });

  it("runs holders of the same key one at a time, in the order they asked", async () => {
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;

    const job = async (name: string, ms: number) => {
      const release = await acquireSlot("same");
      try {
        running++;
        maxRunning = Math.max(maxRunning, running);
        log.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        log.push(`end ${name}`);
        running--;
      } finally {
        release();
      }
    };

    await Promise.all([job("a", 30), job("b", 5), job("c", 5)]);

    expect(maxRunning).toBe(1);
    expect(log).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
    ]);
  });

  it("lets different keys run at the same time", async () => {
    let running = 0;
    let maxRunning = 0;
    const job = async (key: string) => {
      const release = await acquireSlot(key);
      try {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running--;
      } finally {
        release();
      }
    };
    await Promise.all([job("k1"), job("k2"), job("k3")]);
    expect(maxRunning).toBe(3);
  });

  it("is not blocked by a holder that failed (released in a finally)", async () => {
    const failing = (async () => {
      const release = await acquireSlot("err");
      try {
        throw new Error("boom");
      } finally {
        release();
      }
    })();
    await expect(failing).rejects.toThrow("boom");

    const release = await acquireSlot("err");
    release();
  });

  it("treats releasing twice as harmless", async () => {
    const first = await acquireSlot("twice");
    first();
    first();
    const second = await acquireSlot("twice");
    second();
    expect(pendingKeyCount()).toBe(0);
  });

  it("forgets a key once nobody is queued, so memory does not grow", async () => {
    const releases = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const release = await acquireSlot(`key-${i}`);
        return release;
      })
    );
    for (const release of releases) release();
    await tick();
    expect(pendingKeyCount()).toBe(0);
  });

  it("keeps the key while others are waiting, then clears it", async () => {
    const first = await acquireSlot("busy");
    const waiting = acquireSlot("busy");
    expect(pendingKeyCount()).toBeGreaterThan(0);
    first();
    const second = await waiting;
    second();
    await tick();
    expect(pendingKeyCount()).toBe(0);
  });
});
