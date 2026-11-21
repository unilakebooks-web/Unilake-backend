import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/lib/email.js", () => ({
  sendEmail: vi.fn(),
  EmailGuardRefusal: class extends Error {},
  EmailSendError: class extends Error {},
  isRecipientAllowed: () => true,
  devAllowedRecipients: () => null,
}));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/config/env.js", () => ({
  config: { frontendUrl: "https://shop.example.test" },
}));

import { withSendTimeout } from "../../src/services/reminder.service.js";

describe("withSendTimeout", () => {
  it("returns the answer of a send that answers in time", async () => {
    await expect(withSendTimeout(Promise.resolve("ok"), 50)).resolves.toBe(
      "ok"
    );
  });

  it("gives up on a send that never answers, so a hung request cannot hold the run", async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withSendTimeout(never, 20)).rejects.toThrow("send timed out");
  });

  it("passes on the error of a send that fails in time", async () => {
    await expect(
      withSendTimeout(Promise.reject(new Error("boom")), 50)
    ).rejects.toThrow("boom");
  });
});
