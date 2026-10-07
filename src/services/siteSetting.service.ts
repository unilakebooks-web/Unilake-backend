import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import type { UpdateSiteSettingInput } from "../validators/siteSetting.schema.js";

/**
 * Matches the `@default("singleton")` on SiteSetting.id in schema.prisma.
 *
 * Because the id is fixed, this table holds exactly one row by construction —
 * every read and write targets the same primary key. That makes it simpler
 * than the HowItWorks singleton, which has to findFirst with a deterministic
 * orderBy to cope with duplicate rows that should never exist but might.
 * There is no such ambiguity here, and no ordering to agree on.
 */
const SINGLETON_ID = "singleton";

/**
 * Public read — consumed by the /contact page AND the site-wide Footer.
 *
 * Returns null rather than throwing when nothing has been saved yet. The
 * footer calls this on every page load, so a 404 on a fresh install would be
 * console noise on every navigation rather than useful information. Same
 * convention as getPublicHowItWorks.
 */
export async function getSiteSettingPublic() {
  return prisma.siteSetting.findUnique({ where: { id: SINGLETON_ID } });
}

/**
 * Admin read.
 *
 * Identical to the public read today. Kept as a separate function so there is
 * already a seam if the two ever need to diverge — the same reason the Blog
 * and HowItWorks modules split theirs.
 */
export async function getSiteSettingAdmin() {
  return prisma.siteSetting.findUnique({ where: { id: SINGLETON_ID } });
}

/**
 * Create-or-update the one row.
 *
 * Zod has already stripped keys the caller omitted, so spreading `data`
 * straight into `update` touches only the columns actually sent — a PATCH with
 * just `{ email }` leaves brandDescription and every social link alone. An
 * explicit null still comes through as a key and clears that column, which is
 * the distinction the validator's `.nullable().optional()` pairs exist to
 * preserve.
 *
 * `create` gets the same spread: on the very first save the row does not exist
 * yet, and whatever subset the admin submitted becomes its initial state.
 */
export async function updateSiteSetting(data: UpdateSiteSettingInput) {
  const setting = await prisma.siteSetting.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...data },
    update: data,
  });

  logger.info(
    { updatedFields: Object.keys(data) },
    "Site settings saved"
  );

  return setting;
}
