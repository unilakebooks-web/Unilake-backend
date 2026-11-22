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

import { classifyResendError } from "../../src/services/reminder.service.js";
import type { EmailSendError } from "../../src/lib/email.js";

const err = (name: string, status: number, message = "") =>
  ({
    providerName: name,
    providerStatus: status,
    message: `Resend send failed: ${name}: ${message} (HTTP ${status})`,
  }) as EmailSendError;

describe("classifyResendError", () => {
  it.each([
    ["daily_quota_exceeded", 429],
    ["monthly_quota_exceeded", 429],
    ["rate_limit_exceeded", 429],
  ])("%s is a limit", (name, status) => {
    expect(classifyResendError(err(name, status))).toBe("limited");
  });

  it.each([
    ["invalid_api_key", 400, ""],
    ["missing_api_key", 401, ""],
    ["restricted_api_key", 401, ""],
    ["invalid_from_address", 422, "Invalid `from` field"],
    ["invalid_access", 400, ""],
    ["validation_error", 403, "domain is not verified"],
    ["missing_required_field", 422, "Missing `from` field."],
    ["validation_error", 422, "Invalid `from` field. The email address needs"],
    ["invalid_parameter", 400, "The API key is not valid"],
  ])("%s (HTTP %i) is a setup error of the account", (name, status, text) => {
    expect(classifyResendError(err(name, status, text))).toBe("config");
  });

  it.each([
    ["validation_error", 422, "Invalid `to` field"],
    ["invalid_parameter", 422, "Invalid email address in `to`"],
    ["missing_required_field", 422, "Missing `subject` field"],
    ["validation_error", 400, "Invalid `html` field"],
  ])(
    "%s (HTTP %i, %s) is a refusal of that one message",
    (name, status, text) => {
      expect(classifyResendError(err(name, status, text))).toBe("refused");
    }
  );

  it("an idempotency conflict, a 5xx and anything else is unknown", () => {
    expect(
      classifyResendError(err("concurrent_idempotent_requests", 409))
    ).toBe("unknown");
    expect(classifyResendError(err("internal_server_error", 500))).toBe(
      "unknown"
    );
    expect(classifyResendError(err("unknown", 502))).toBe("unknown");
  });
});
