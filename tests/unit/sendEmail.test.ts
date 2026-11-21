import { describe, it, expect, vi, beforeEach } from "vitest";

// sendEmail is the one place that talks to Resend. These tests pin down what it
// sends (unchanged unless the new optional fields are given), the development
// guard (outside production only addresses in DEV_EMAIL_ALLOWLIST get mail) and
// the typed error that tells callers what Resend said.

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));
vi.mock("../../src/lib/logger.js", () => ({ logger: mocks.logger }));

type Settings = { nodeEnv: string; allow?: string[] };

// email.ts reads the config when it loads, so each case loads a fresh copy.
async function load({ nodeEnv, allow = [] }: Settings) {
  vi.resetModules();
  vi.doMock("../../src/config/env.js", () => ({
    config: {
      nodeEnv,
      devEmailAllowlist: allow,
      email: {
        resendApiKey: "key",
        fromAddress: "noreply@example.test",
        fromName: "Unilake Kids",
      },
    },
  }));
  return import("../../src/lib/email.js");
}

const MAIL = {
  to: "parent@example.test",
  subject: "Hello",
  html: '<p>Hi <a href="https://x.test">link</a></p>',
};

beforeEach(() => {
  mocks.send
    .mockReset()
    .mockResolvedValue({ data: { id: "msg-1" }, error: null });
  Object.values(mocks.logger).forEach((fn) => fn.mockClear());
});

describe("sendEmail payload", () => {
  it("in production, without the new fields, sends exactly the payload it always did", async () => {
    const { sendEmail } = await load({ nodeEnv: "production" });
    expect(await sendEmail(MAIL)).toEqual({ messageId: "msg-1" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const args = mocks.send.mock.calls[0]!;
    expect(args[1]).toBeUndefined(); // no idempotency options unless a key is given
    expect(args[0]).toEqual({
      from: "Unilake Kids <noreply@example.test>",
      to: MAIL.to,
      replyTo: "unilake.books@gmail.com",
      subject: MAIL.subject,
      html: MAIL.html,
      text: "Hi link: https://x.test",
    });
    expect(Object.keys(args[0]).sort()).toEqual([
      "from",
      "html",
      "replyTo",
      "subject",
      "text",
      "to",
    ]);
  });

  it("the plain-text version does not start with the hidden preheader line", async () => {
    const { sendEmail } = await load({ nodeEnv: "production" });
    await sendEmail({
      ...MAIL,
      html: '<html><body><div style="display:none;font-size:1px;">Hidden preview line</div><p>Visible line</p></body></html>',
    });
    const text = mocks.send.mock.calls[0]![0].text as string;
    expect(text).toContain("Visible line");
    expect(text).not.toContain("Hidden preview line");
  });

  it("passes headers and the idempotency key through only when given", async () => {
    const { sendEmail } = await load({ nodeEnv: "production" });
    await sendEmail({
      ...MAIL,
      headers: { "List-Unsubscribe": "<https://api.example.test/u/abc>" },
      idempotencyKey: "claim-1",
    });
    const [payload, options] = mocks.send.mock.calls[0]!;
    expect(payload.headers).toEqual({
      "List-Unsubscribe": "<https://api.example.test/u/abc>",
    });
    expect(options).toEqual({ idempotencyKey: "claim-1" });
  });

  it("still rejects an empty recipient, subject or body", async () => {
    const { sendEmail } = await load({ nodeEnv: "production" });
    await expect(sendEmail({ ...MAIL, to: " " })).rejects.toThrow(/`to`/);
    await expect(sendEmail({ ...MAIL, subject: "" })).rejects.toThrow(
      /`subject`/
    );
    await expect(sendEmail({ ...MAIL, html: "" })).rejects.toThrow(/`html`/);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("start-up log", () => {
  it("says the development guard is OFF in production and names the environment", async () => {
    await load({ nodeEnv: "production", allow: ["parent@example.test"] });
    const line = mocks.logger.info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain('NODE_ENV="production"');
    expect(line).toContain("guard is OFF");
    expect(line).not.toContain("parent@example.test");
  });

  it.each(["development", "test", "Production", ""])(
    "says the development guard is ACTIVE for NODE_ENV %j, without naming any address",
    async (nodeEnv) => {
      await load({ nodeEnv, allow: ["parent@example.test"] });
      const line = mocks.logger.info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toContain(`NODE_ENV="${nodeEnv}"`);
      expect(line).toContain("guard is ACTIVE");
      expect(line).not.toContain("parent@example.test");
    }
  );
});

describe("development guard", () => {
  it("in production ignores the allowlist and sends to anyone", async () => {
    const { sendEmail } = await load({
      nodeEnv: "production",
      allow: ["someone-else@example.test"],
    });
    await sendEmail(MAIL);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each(["development", "test", "staging", ""])(
    "with NODE_ENV %j and an empty allowlist refuses every send",
    async (nodeEnv) => {
      const { sendEmail, EmailGuardRefusal } = await load({ nodeEnv });
      await expect(sendEmail(MAIL)).rejects.toBeInstanceOf(EmailGuardRefusal);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.logger.error).toHaveBeenCalled();
    }
  );

  it("outside production sends only to allowed addresses, ignoring case and spaces", async () => {
    const { sendEmail, EmailGuardRefusal } = await load({
      nodeEnv: "development",
      allow: ["parent@example.test"],
    });
    await sendEmail({ ...MAIL, to: " Parent@Example.TEST " });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    await expect(
      sendEmail({ ...MAIL, to: "other@example.test" })
    ).rejects.toBeInstanceOf(EmailGuardRefusal);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("a refusal never names the address in its message or in the log", async () => {
    const { sendEmail } = await load({ nodeEnv: "development" });
    const err = await sendEmail(MAIL).catch((e) => e);
    expect(String(err.message)).not.toContain("parent@example.test");
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(
      "parent@example.test"
    );
  });

  it("a refusal is not an EmailSendError, so callers cannot mistake it for a Resend failure", async () => {
    const { sendEmail, EmailGuardRefusal, EmailSendError } = await load({
      nodeEnv: "development",
    });
    const err = await sendEmail(MAIL).catch((e) => e);
    expect(err).toBeInstanceOf(EmailGuardRefusal);
    expect(err).not.toBeInstanceOf(EmailSendError);
  });
});

describe("typed errors and retries", () => {
  it("a Resend error becomes an EmailSendError that carries Resend's name and status", async () => {
    const { sendEmail, EmailSendError } = await load({ nodeEnv: "production" });
    const { AppError } = await import("../../src/utils/errors.js");
    mocks.send.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "bad to", statusCode: 422 },
    });
    const err = await sendEmail(MAIL).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err).toBeInstanceOf(AppError);
    expect(err.providerName).toBe("validation_error");
    expect(err.providerStatus).toBe(422);
    expect(err.code).toBe("EMAIL_SEND_FAILED");
    expect(err.message).toContain("(HTTP 422)"); // text unchanged for existing readers
    expect(mocks.send).toHaveBeenCalledTimes(1); // 4xx is not retried
  });

  it("a rate limit is retried once with the same idempotency key, then reported with its name", async () => {
    const { sendEmail, EmailSendError } = await load({ nodeEnv: "production" });
    mocks.send.mockResolvedValue({
      data: null,
      error: {
        name: "rate_limit_exceeded",
        message: "slow down",
        statusCode: 429,
      },
    });
    const err = await sendEmail({ ...MAIL, idempotencyKey: "claim-9" }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.providerName).toBe("rate_limit_exceeded");
    expect(err.providerStatus).toBe(429);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls.map((c) => c[1])).toEqual([
      { idempotencyKey: "claim-9" },
      { idempotencyKey: "claim-9" },
    ]);
  });

  it("a network failure is retried with the same key, and the second attempt can succeed", async () => {
    const { sendEmail } = await load({ nodeEnv: "production" });
    mocks.send
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ data: { id: "msg-2" }, error: null });
    expect(await sendEmail({ ...MAIL, idempotencyKey: "claim-3" })).toEqual({
      messageId: "msg-2",
    });
    expect(mocks.send.mock.calls.map((c) => c[1])).toEqual([
      { idempotencyKey: "claim-3" },
      { idempotencyKey: "claim-3" },
    ]);
  });

  it("an error without a status is reported as 502, as before", async () => {
    const { sendEmail } = await load({ nodeEnv: "production" });
    mocks.send.mockResolvedValue({
      data: null,
      error: { name: "application_error", message: "oops" },
    });
    const err = await sendEmail(MAIL).catch((e) => e);
    expect(err.providerStatus).toBe(502);
    expect(err.message).toContain("(HTTP 502)");
  });
});
