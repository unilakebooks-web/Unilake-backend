import { describe, it, expect, vi } from "vitest";
import { errorHandler } from "../../src/middlewares/errorHandler.js";

function run(err: Error & { type?: string }) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  errorHandler(
    err,
    { method: "POST", originalUrl: "/x" } as never,
    { status } as never,
    vi.fn()
  );
  return { status, json };
}

describe("errorHandler for a bad request body", () => {
  it("answers 400 for invalid JSON", () => {
    const { status, json } = run(
      Object.assign(new SyntaxError("Unexpected token"), {
        type: "entity.parse.failed",
      })
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: "INVALID_JSON",
        message: "The request body is not valid JSON.",
      },
    });
  });

  it("answers 413 for a body that is too large", () => {
    const { status, json } = run(
      Object.assign(new Error("request entity too large"), {
        type: "entity.too.large",
      })
    );
    expect(status).toHaveBeenCalledWith(413);
    expect(json.mock.calls[0]![0].error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("still answers 500 for any other error", () => {
    const { status } = run(new Error("boom"));
    expect(status).toHaveBeenCalledWith(500);
  });
});
