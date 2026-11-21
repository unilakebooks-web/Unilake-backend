import { describe, it, expect, vi, afterEach } from "vitest";
import { Readable } from "node:stream";

// The bounded storage reads of the share routes (feature 14). Nothing here may reach a bucket: the configuration is
// replaced, the logger silenced and every storage call is a spy on the S3 client.
vi.mock("../../src/config/env.js", () => ({
  config: {
    r2: {
      endpoint: "http://127.0.0.1:1",
      accessKeyId: "test",
      secretAccessKey: "test",
      publicBucket: "public-test",
      privateBucket: "private-test",
      publicUrlBase: "https://media.example.test/",
    },
  },
}));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  headObjectChecked,
  openObjectChecked,
  r2Client,
  StorageObjectRefusedError,
} from "../../src/lib/r2.js";

const OPTIONS = { maxBytes: 1000, firstByteTimeoutMs: 50, readDeadlineMs: 80 };

afterEach(() => vi.restoreAllMocks());

const send = (
  impl: (command: unknown, options?: { abortSignal?: AbortSignal }) => unknown
) => vi.spyOn(r2Client, "send").mockImplementation(impl as never);

const missing = (name: string) => Object.assign(new Error("gone"), { name });

describe("headObjectChecked", () => {
  it("returns the size and ETag", async () => {
    send(async () => ({ ContentLength: 12, ETag: '"abc"' }));
    expect(await headObjectChecked("k", 100)).toEqual({
      contentLength: 12,
      etag: '"abc"',
    });
  });
  it("answers null for a missing object, whichever way storage says it", async () => {
    for (const error of [
      missing("NoSuchKey"),
      missing("NotFound"),
      Object.assign(new Error("x"), { $metadata: { httpStatusCode: 404 } }),
    ]) {
      send(async () => {
        throw error;
      });
      expect(await headObjectChecked("k", 100)).toBeNull();
    }
  });
  it("throws every other failure", async () => {
    send(async () => {
      throw missing("InternalError");
    });
    await expect(headObjectChecked("k", 100)).rejects.toThrow();
  });
});

describe("openObjectChecked", () => {
  const body = (chunks: Buffer[]) => Readable.from(chunks);

  it("answers null for a missing object", async () => {
    send(async () => {
      throw missing("NoSuchKey");
    });
    expect(await openObjectChecked("k", OPTIONS)).toBeNull();
  });

  it("reads a body within the size and returns its bytes, size and ETag", async () => {
    send(async () => ({
      Body: body([Buffer.from("hello "), Buffer.from("world")]),
      ContentLength: 11,
      ETag: '"e"',
    }));
    const opened = await openObjectChecked("k", OPTIONS);
    expect(opened).not.toBeNull();
    expect(opened!.contentLength).toBe(11);
    expect(opened!.etag).toBe('"e"');
    expect((await opened!.read()).toString()).toBe("hello world");
  });

  it("refuses an object that does not say its size", async () => {
    send(async () => ({ Body: body([Buffer.from("x")]) }));
    await expect(openObjectChecked("k", OPTIONS)).rejects.toBeInstanceOf(
      StorageObjectRefusedError
    );
  });

  it("accepts exactly the limit and refuses one byte more", async () => {
    send(async () => ({
      Body: body([Buffer.alloc(1000)]),
      ContentLength: 1000,
    }));
    expect((await (await openObjectChecked("k", OPTIONS))!.read()).length).toBe(
      1000
    );
    send(async () => ({
      Body: body([Buffer.alloc(1001)]),
      ContentLength: 1001,
    }));
    await expect(openObjectChecked("k", OPTIONS)).rejects.toBeInstanceOf(
      StorageObjectRefusedError
    );
  });

  it("counts the bytes that arrive: a body longer than its header says is refused", async () => {
    send(async () => ({
      Body: body([Buffer.alloc(600), Buffer.alloc(600)]),
      ContentLength: 10,
    }));
    const opened = await openObjectChecked("k", OPTIONS);
    await expect(opened!.read()).rejects.toBeInstanceOf(
      StorageObjectRefusedError
    );
  });

  it("aborts when no first byte arrives in time", async () => {
    send(
      (_command, options) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    );
    await expect(openObjectChecked("k", OPTIONS)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("stops the first-byte timer once the headers arrive, so a slow body is not cut by it", async () => {
    const slow = new Readable({ read() {} });
    send(async () => ({ Body: slow, ContentLength: 5 }));
    const opened = await openObjectChecked("k", {
      ...OPTIONS,
      firstByteTimeoutMs: 20,
      readDeadlineMs: 500,
    });
    const reading = opened!.read();
    setTimeout(() => {
      slow.push(Buffer.from("12345"));
      slow.push(null);
    }, 60); // later than the first-byte timeout
    expect((await reading).toString()).toBe("12345");
  });

  it("ends a body that never finishes at the read deadline", async () => {
    const stalled = new Readable({ read() {} });
    stalled.push(Buffer.from("ab"));
    send(async () => ({ Body: stalled, ContentLength: 5 }));
    const opened = await openObjectChecked("k", OPTIONS);
    await expect(opened!.read()).rejects.toThrow();
    expect(stalled.destroyed).toBe(true);
  });

  it("discard destroys the body", async () => {
    const stream = new Readable({ read() {} });
    send(async () => ({ Body: stream, ContentLength: 5 }));
    const opened = await openObjectChecked("k", OPTIONS);
    opened!.discard();
    expect(stream.destroyed).toBe(true);
  });

  it("throws every other storage failure", async () => {
    send(async () => {
      throw missing("InternalError");
    });
    await expect(openObjectChecked("k", OPTIONS)).rejects.toThrow();
  });
});
