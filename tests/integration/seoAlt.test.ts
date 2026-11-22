// Integration tests for the alt text fields of the SEO work on the team member service: set on
// create, changed and cleared on update, left alone when omitted, returned by the admin and the
// public lists. Hero image and How It Works alt text are covered by the schema tests (hero create
// converts an uploaded file, and How It Works is a singleton, so they stay off the database). They
// run against the Neon TEST branch only: the setup import refuses any other database.
import "../setup/env.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/r2.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/r2.js")>()),
  deleteFile: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../../src/lib/prisma.js";
import {
  createTeamMember,
  getActiveTeamMembers,
  getAllTeamMembers,
  updateTeamMember,
} from "../../src/services/teamMember.service.js";
import { updateHeroImage } from "../../src/services/heroImage.service.js";
import {
  createGoogleReview,
  getActiveGoogleReviews,
  getAllGoogleReviews,
  updateGoogleReview,
} from "../../src/services/googleReview.service.js";
import { NotFoundError } from "../../src/utils/errors.js";

const MARK = "__vitest_seoalt__";
const RUN = Math.random().toString(36).slice(2, 8);
const NAME = (label: string) => `${MARK} ${RUN} ${label}`;
const ids: string[] = [];

beforeAll(async () => {
  await prisma.teamMember.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.googleReview.deleteMany({
    where: { customerName: { startsWith: MARK } },
  });
});

afterAll(async () => {
  await prisma.googleReview.deleteMany({
    where: { customerName: { startsWith: MARK } },
  });
  await prisma.teamMember.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("team member imageAlt", () => {
  it("an old payload without it leaves the column null", async () => {
    const member = await createTeamMember({
      name: NAME("old"),
      role: "Tester",
    });
    ids.push(member.id);
    expect(member.imageAlt).toBeNull();
  });

  it("is saved on create, changed on update, kept when omitted and cleared with null", async () => {
    const member = await createTeamMember({
      name: NAME("alt"),
      role: "Tester",
      imageAlt: "Asha at her desk",
    });
    ids.push(member.id);
    expect(member.imageAlt).toBe("Asha at her desk");

    const changed = await updateTeamMember(member.id, {
      imageAlt: "Asha smiling",
    });
    expect(changed.imageAlt).toBe("Asha smiling");

    const untouched = await updateTeamMember(member.id, { role: "Lead" });
    expect(untouched.imageAlt).toBe("Asha smiling");

    const cleared = await updateTeamMember(member.id, { imageAlt: null });
    expect(cleared.imageAlt).toBeNull();
  });

  it("is returned by the admin and the public lists", async () => {
    const member = await createTeamMember({
      name: NAME("lists"),
      role: "Tester",
      imageAlt: "In both lists",
    });
    ids.push(member.id);
    const admin = (await getAllTeamMembers()).find((m) => m.id === member.id);
    const pub = (await getActiveTeamMembers()).find((m) => m.id === member.id);
    expect(admin?.imageAlt).toBe("In both lists");
    expect(pub?.imageAlt).toBe("In both lists");
  });
});

describe("hero image alt update", () => {
  const heroIds: string[] = [];

  afterAll(async () => {
    await prisma.heroImage.deleteMany({ where: { id: { in: heroIds } } });
  });

  it("sets, changes and clears the alt text, and leaves the picture alone", async () => {
    const hero = await prisma.heroImage.create({
      data: { imageUrl: "https://example.test/__vitest_seoalt__.webp" },
    });
    heroIds.push(hero.id);
    expect(hero.imageAlt).toBeNull();

    const set = await updateHeroImage(hero.id, {
      imageAlt: "Children reading",
    });
    expect(set.imageAlt).toBe("Children reading");
    expect(set.imageUrl).toBe(hero.imageUrl);

    const same = await updateHeroImage(hero.id, {});
    expect(same.imageAlt).toBe("Children reading");

    const cleared = await updateHeroImage(hero.id, { imageAlt: null });
    expect(cleared.imageAlt).toBeNull();
  });

  it("is a 404 for an unknown id", async () => {
    await expect(
      updateHeroImage("00000000-0000-4000-8000-00000000dead", { imageAlt: "x" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("google review imageAlt", () => {
  const review = (label: string, extra: Record<string, unknown> = {}) =>
    createGoogleReview({
      customerName: NAME(label),
      rating: 5,
      reviewText: "Lovely book",
      imageKey: `google-reviews/__vitest_seoalt__-${RUN}.webp`,
      ...extra,
    });

  it("an old payload without it leaves the column null", async () => {
    expect((await review("old")).imageAlt).toBeNull();
  });

  it("is saved on create, changed on update, kept when omitted and cleared with null", async () => {
    const created = await review("alt", { imageAlt: "A child with the book" });
    expect(created.imageAlt).toBe("A child with the book");

    const changed = await updateGoogleReview(created.id, {
      imageAlt: "A smiling child",
    });
    expect(changed.imageAlt).toBe("A smiling child");

    const untouched = await updateGoogleReview(created.id, { rating: 4 });
    expect(untouched.imageAlt).toBe("A smiling child");

    const cleared = await updateGoogleReview(created.id, { imageAlt: null });
    expect(cleared.imageAlt).toBeNull();
  });

  it("is returned by the admin list and the public list", async () => {
    const created = await review("lists", { imageAlt: "In both lists" });
    const admin = (await getAllGoogleReviews()).find((r) => r.id === created.id);
    const publicRow = (await getActiveGoogleReviews()).find(
      (r) => r.id === created.id
    );
    expect(admin?.imageAlt).toBe("In both lists");
    expect(publicRow?.imageAlt).toBe("In both lists");
  });
});
