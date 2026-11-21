import { describe, expect, it } from "vitest";
import {
  deletionGroupSchema,
  deletionItemActionSchema,
  retryDeletionSchema,
  setDeletionModeSchema,
  undoGhostSchema,
} from "../../src/validators/dataDeletion.schema.js";

const uuid = "11111111-2222-4333-8444-555555555555";

describe("the data deletion admin schemas", () => {
  it("accepts only the three groups", () => {
    for (const g of ["PREVIEWS", "PHOTOS", "BOOKS"])
      expect(deletionGroupSchema.safeParse(g).success).toBe(true);
    for (const g of ["previews", "", "ALL", "PREVIEWS ", 1, null])
      expect(deletionGroupSchema.safeParse(g).success).toBe(false);
  });

  it("switch mode: a mode is required, extra fields are refused, bounds are enforced", () => {
    expect(setDeletionModeSchema.safeParse({ mode: "OFF" }).success).toBe(true);
    expect(setDeletionModeSchema.safeParse({}).success).toBe(false);
    expect(setDeletionModeSchema.safeParse({ mode: "active" }).success).toBe(
      false
    );
    expect(
      setDeletionModeSchema.safeParse({ mode: "OFF", extra: 1 }).success
    ).toBe(false);
    for (const dailyMax of [0, 501, 1.5, "10", -1, NaN]) {
      expect(
        setDeletionModeSchema.safeParse({ mode: "REPORT_ONLY", dailyMax })
          .success,
        String(dailyMax)
      ).toBe(false);
    }
    for (const dailyMax of [1, 100, 500]) {
      expect(
        setDeletionModeSchema.safeParse({ mode: "REPORT_ONLY", dailyMax })
          .success
      ).toBe(true);
    }
    expect(
      setDeletionModeSchema.safeParse({
        mode: "ACTIVE",
        reportRunId: "not-a-uuid",
      }).success
    ).toBe(false);
    expect(
      setDeletionModeSchema.safeParse({
        mode: "ACTIVE",
        expectedModeChangedAt: "2031-06-15T12:00:00.000Z",
        reportRunId: uuid,
        dueCount: 3,
        confirmation: "DELETE 3",
      }).success
    ).toBe(true);
    // The switch to ACTIVE must carry the time the page saw; other modes may leave it out.
    expect(
      setDeletionModeSchema.safeParse({
        mode: "ACTIVE",
        reportRunId: uuid,
        dueCount: 3,
        confirmation: "DELETE 3",
      }).success
    ).toBe(false);
    expect(
      setDeletionModeSchema.safeParse({
        mode: "ACTIVE",
        expectedModeChangedAt: "yesterday",
      }).success
    ).toBe(false);
    expect(
      setDeletionModeSchema.safeParse({ mode: "ACTIVE", dueCount: -1 }).success
    ).toBe(false);
    expect(
      setDeletionModeSchema.safeParse({
        mode: "ACTIVE",
        confirmation: "x".repeat(41),
      }).success
    ).toBe(false);
  });

  it("retry needs exactly one of an item or a group", () => {
    expect(retryDeletionSchema.safeParse({ itemId: uuid }).success).toBe(true);
    expect(retryDeletionSchema.safeParse({ group: "BOOKS" }).success).toBe(
      true
    );
    expect(retryDeletionSchema.safeParse({}).success).toBe(false);
    expect(
      retryDeletionSchema.safeParse({ itemId: uuid, group: "BOOKS" }).success
    ).toBe(false);
    expect(retryDeletionSchema.safeParse({ itemId: "x" }).success).toBe(false);
  });

  it("release needs a uuid item id and nothing else", () => {
    expect(deletionItemActionSchema.safeParse({ itemId: uuid }).success).toBe(
      true
    );
    expect(deletionItemActionSchema.safeParse({ itemId: "x" }).success).toBe(
      false
    );
    expect(
      deletionItemActionSchema.safeParse({ itemId: uuid, extra: true }).success
    ).toBe(false);
    expect(deletionItemActionSchema.safeParse({}).success).toBe(false);
  });

  it("undo ghost needs an item, or a time range with the start before the end", () => {
    expect(undoGhostSchema.safeParse({ itemId: uuid }).success).toBe(true);
    expect(
      undoGhostSchema.safeParse({
        from: "2031-01-01T00:00:00Z",
        to: "2031-01-02T00:00:00Z",
      }).success
    ).toBe(true);
    expect(
      undoGhostSchema.safeParse({
        from: "2031-01-02T00:00:00Z",
        to: "2031-01-01T00:00:00Z",
      }).success
    ).toBe(false);
    expect(
      undoGhostSchema.safeParse({
        from: "2031-01-01T00:00:00Z",
        to: "2031-01-01T00:00:00Z",
      }).success
    ).toBe(false);
    expect(
      undoGhostSchema.safeParse({ from: "2031-01-01T00:00:00Z" }).success
    ).toBe(false);
    expect(
      undoGhostSchema.safeParse({
        itemId: uuid,
        from: "2031-01-01T00:00:00Z",
        to: "2031-01-02T00:00:00Z",
      }).success
    ).toBe(false);
    expect(undoGhostSchema.safeParse({}).success).toBe(false);
  });
});
