import { describe, it, expect } from "vitest";
import {
  listAdminOrdersQuerySchema,
  setSentToPrinterBodySchema,
} from "../../src/validators/order.schema.js";

describe("setSentToPrinterBodySchema", () => {
  it("accepts true and false", () => {
    expect(setSentToPrinterBodySchema.parse({ sent: true })).toEqual({
      sent: true,
    });
    expect(setSentToPrinterBodySchema.parse({ sent: false })).toEqual({
      sent: false,
    });
  });

  it("ignores unknown keys", () => {
    expect(setSentToPrinterBodySchema.parse({ sent: true, extra: 1 })).toEqual({
      sent: true,
    });
  });

  it("rejects a missing or non-boolean sent", () => {
    expect(setSentToPrinterBodySchema.safeParse({}).success).toBe(false);
    expect(setSentToPrinterBodySchema.safeParse({ sent: "true" }).success).toBe(
      false
    );
    expect(setSentToPrinterBodySchema.safeParse({ sent: 1 }).success).toBe(
      false
    );
    expect(setSentToPrinterBodySchema.safeParse({ sent: null }).success).toBe(
      false
    );
    expect(setSentToPrinterBodySchema.safeParse(undefined).success).toBe(false);
  });
});

describe("listAdminOrdersQuerySchema sentToPrinter filter", () => {
  it("is optional", () => {
    expect(listAdminOrdersQuerySchema.parse({}).sentToPrinter).toBeUndefined();
  });

  it("accepts sent and not_sent", () => {
    expect(
      listAdminOrdersQuerySchema.parse({ sentToPrinter: "sent" }).sentToPrinter
    ).toBe("sent");
    expect(
      listAdminOrdersQuerySchema.parse({ sentToPrinter: "not_sent" })
        .sentToPrinter
    ).toBe("not_sent");
  });

  it("rejects any other value", () => {
    expect(
      listAdminOrdersQuerySchema.safeParse({ sentToPrinter: "all" }).success
    ).toBe(false);
    expect(
      listAdminOrdersQuerySchema.safeParse({ sentToPrinter: "" }).success
    ).toBe(false);
  });
});
