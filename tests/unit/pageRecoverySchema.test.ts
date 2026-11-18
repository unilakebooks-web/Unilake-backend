import { describe, expect, it } from "vitest";
import {
  orderPagesParamsSchema,
  orderPagesQuerySchema,
  regenerateOrderPagesBodySchema,
} from "../../src/validators/pageRecovery.schema.js";

describe("page recovery request schemas", () => {
  it("accepts an empty body, named pages, force and repairOnly", () => {
    expect(regenerateOrderPagesBodySchema.safeParse({}).success).toBe(true);
    expect(
      regenerateOrderPagesBodySchema.safeParse({
        pageNumbers: [1, 4],
        force: true,
      }).success
    ).toBe(true);
    expect(
      regenerateOrderPagesBodySchema.safeParse({ repairOnly: true }).success
    ).toBe(true);
  });

  it("rejects an empty page list (it would restart the whole book in a restore), zero, fractions, text and too many pages", () => {
    for (const body of [
      { pageNumbers: [] },
      { pageNumbers: [0] },
      { pageNumbers: [1.5] },
      { pageNumbers: ["3"] },
      { pageNumbers: Array.from({ length: 101 }, (_, i) => i + 1) },
      { force: "yes" },
      { repairOnly: 1 },
    ]) {
      expect(
        regenerateOrderPagesBodySchema.safeParse(body).success,
        JSON.stringify(body).slice(0, 40)
      ).toBe(false);
    }
  });

  it("limits the long poll to 25 seconds and the order id to a uuid", () => {
    expect(
      orderPagesQuerySchema.safeParse({ wait: "25", sig: "abc" }).success
    ).toBe(true);
    expect(orderPagesQuerySchema.safeParse({ wait: "26" }).success).toBe(false);
    expect(orderPagesQuerySchema.safeParse({ wait: "-1" }).success).toBe(false);
    expect(orderPagesQuerySchema.safeParse({ wait: "1.5" }).success).toBe(
      false
    );
    expect(orderPagesParamsSchema.safeParse({ orderId: "nope" }).success).toBe(
      false
    );
    expect(
      orderPagesParamsSchema.safeParse({
        orderId: "00000000-0000-4000-8000-000000000001",
      }).success
    ).toBe(true);
  });
});
