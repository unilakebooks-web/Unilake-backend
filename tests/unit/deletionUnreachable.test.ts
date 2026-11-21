import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/lib/r2.js", () => ({
  countPrefix: vi.fn(),
  deleteKeyChecked: vi.fn(),
  isDeletionKey: vi.fn(),
  listObjectsPage: vi.fn(),
  objectExists: vi.fn(),
  pdfKeyFor: vi.fn(),
  putObjectChecked: vi.fn(),
}));
vi.mock("../../src/services/orderAddress.service.js", () => ({
  lockOrderAddress: vi.fn(),
}));
vi.mock("../../src/services/session.service.js", () => ({
  EXPIRY_EXEMPT_STATUSES: [],
}));
vi.mock("../../src/lib/razorpay.js", () => ({ razorpay: {} }));
vi.mock("../../src/config/env.js", () => ({
  config: {
    r2: {
      publicBucket: "pub",
      privateBucket: "priv",
      publicUrlBase: "https://pub.example/",
    },
  },
}));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { isUnreachable } from "../../src/services/dataDeletionEngine.service.js";

describe("isUnreachable: a storage fault that stops the run instead of marking an item", () => {
  it("network and timeout faults", () => {
    for (const name of ["AbortError", "TimeoutError", "NetworkingError"])
      expect(isUnreachable({ name })).toBe(true);
    for (const code of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ])
      expect(isUnreachable({ code })).toBe(true);
  });

  it("a refused or revoked token (401, 403, AccessDenied...) and any 5xx", () => {
    for (const status of [401, 403, 500, 502, 503]) {
      expect(
        isUnreachable({ $metadata: { httpStatusCode: status } }),
        String(status)
      ).toBe(true);
    }
    for (const name of [
      "AccessDenied",
      "InvalidAccessKeyId",
      "SignatureDoesNotMatch",
      "Forbidden",
      "Unauthorized",
    ]) {
      expect(isUnreachable({ name }), name).toBe(true);
    }
  });

  it("an ordinary item error, a 404 and a non-object are not", () => {
    for (const status of [400, 404, 409, 429])
      expect(isUnreachable({ $metadata: { httpStatusCode: status } })).toBe(
        false
      );
    expect(isUnreachable(new Error("boom"))).toBe(false);
    expect(isUnreachable({ name: "NoSuchKey" })).toBe(false);
    expect(isUnreachable(null)).toBe(false);
    expect(isUnreachable("text")).toBe(false);
  });
});
