import { randomUUID } from "node:crypto";
import {
  deleteFile,
  getKeyFromPublicUrl,
  getPublicUrl,
  getSignedUploadUrl,
} from "../lib/r2.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import type {
  CreateCountryInput,
  UpdateCountryInput,
} from "../validators/country.schema.js";

export const generateFlagUploadUrl = async (
  fileName: string,
  contentType: string
) => {
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");

  const key = `flags/${randomUUID()}-${safeFileName}`;

  logger.info(
    { key, contentType },
    "Requesting presigned URL from Cloudflare R2"
  );

  const uploadUrl = await getSignedUploadUrl("public", key, contentType, 900);

  return { uploadUrl, key };
};

export const createCountry = async (data: CreateCountryInput) => {
  try {
    logger.info(
      { code: data.code, name: data.name },
      "Attempting to create new country record..."
    );

    const resolvedFlagUrl = getPublicUrl(data.flagKey);

    const newCountry = await prisma.country.create({
      data: {
        code: data.code,
        name: data.name,
        currencyCode: data.currencyCode,
        flagUrl: resolvedFlagUrl, // ⬅️ Map the resolved URL to the Prisma schema field
      },
    });

    logger.info({ countryId: newCountry.id }, "Successfully created country");

    return newCountry;
  } catch (error: any) {
    logger.error({ err: error, data }, "Failed to create country in database");

    if (error.code === "P2002") {
      throw new ConflictError(
        `A country with the code '${data.code}' already exists.`
      );
    }

    throw error;
  }
};

export const updateCountry = async (
  countryId: any,
  data: UpdateCountryInput
) => {
  try {
    logger.info(
      { countryId },
      "Attempting to update existing country record..."
    );

    let finalFlagUrl: string | undefined;

    if (data.flagKey) {
      finalFlagUrl = getPublicUrl(data.flagKey);
    }

    const updatedCountry = await prisma.country.update({
      where: { id: countryId },
      data: {
        ...(data.code !== undefined && { code: data.code }),
        ...(data.name !== undefined && { name: data.name }),
        ...(data.currencyCode !== undefined && {
          currencyCode: data.currencyCode,
        }),
        ...(finalFlagUrl !== undefined && { flagUrl: finalFlagUrl }),
      },
    });

    logger.info({ countryId }, "Successfully updated country");
    return updatedCountry;
  } catch (error: any) {
    logger.error({ err: error, countryId, data }, "Failed to update country");
    if (error.code === "P2025") {
      throw new NotFoundError("The requested country record does not exist.");
    }
    if (error.code === "P2002") {
      throw new ConflictError("A country with this code already exists.");
    }
    throw error;
  }
};

export const getAllCountries = async () => {
  try {
    logger.debug("Fetching all countries from the database...");

    const countries = await prisma.country.findMany({
      orderBy: {
        name: "asc",
      },
      // Admin-only. Powers the "this will also delete N pricing rule(s)"
      // warning in the delete dialog — deleting a country cascades its
      // pricing rules away, so the admin is told the blast radius first.
      // Deliberately NOT added to getActiveCountries(): that list is public
      // and carries an explicit select so internals never leak.
      include: {
        _count: { select: { pricingRules: true } },
      },
    });

    return countries;
  } catch (error: any) {
    logger.error({ err: error }, "Failed to fetch countries from the database");
    throw error;
  }
};

/**
 * Public-facing country list — active countries only.
 *
 * Separate from getAllCountries() rather than a flag on it: the admin list must
 * always show inactive rows (that is how they get re-activated), and the two
 * callers also need different field sets. Explicit select here so `isActive`
 * itself never leaks — every row in the response is active by definition, and
 * exposing the column invites the frontend to filter on it a second time.
 */
export const getActiveCountries = async () => {
  try {
    logger.debug("Fetching active countries from the database...");

    const countries = await prisma.country.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        currencyCode: true,
        flagUrl: true,
      },
    });

    return countries;
  } catch (error: any) {
    logger.error(
      { err: error },
      "Failed to fetch active countries from the database"
    );
    throw error;
  }
};

/**
 * Deletes a country and every pricing rule that references it.
 *
 * The pricing rules go via the DB-level `onDelete: Cascade` on
 * PricingRule.country — this function never deletes them itself. The delete is
 * unconditional by design: it used to 409 when any pricing rule referenced the
 * country, which left the admin with no route out short of hand-deleting rules
 * comic by comic.
 *
 * Note this wipes pricing for every comic priced in that country, PUBLISHED
 * ones included, with no undo. The admin-panel confirmation dialog showing the
 * rule count is what guards against an accidental click — hence the count
 * exposed on getAllCountries() and returned here.
 */
export const deleteCountry = async (countryId: string) => {
  const country = await prisma.country.findUnique({
    where: { id: countryId },
  });

  if (!country) {
    throw new NotFoundError("Country not found.");
  }

  // NOT a guard — read before the delete purely so we can report how many rows
  // the cascade took with it. Must run before country.delete(), or the rules
  // are already gone and this always reads 0.
  const pricingRuleCount = await prisma.pricingRule.count({
    where: { countryId },
  });

  await prisma.country.delete({ where: { id: countryId } });

  // DB first, R2 second, best-effort — same ordering as deleteHeroImage. The
  // cascade has already committed by this point, so a failed cleanup must
  // never fail the request; it just leaves an orphaned flag in the bucket.
  const r2Key = getKeyFromPublicUrl(country.flagUrl);

  try {
    await deleteFile("public", r2Key);
  } catch (error) {
    logger.warn(
      { error, countryId, r2Key },
      "Country deleted from database but R2 flag cleanup failed"
    );
  }

  logger.info(
    { countryId, countryCode: country.code, deletedPricingRules: pricingRuleCount },
    "Country deleted"
  );

  return { deletedPricingRules: pricingRuleCount };
};
