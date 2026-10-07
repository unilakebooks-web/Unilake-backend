import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

/**
 * Tiny wrapper around the SystemConfig key-value table.
 *
 * SystemConfig is our persistence layer for small runtime state that must
 * survive server restarts AND be shared across processes (web + workers).
 * The Shiprocket auth token is the first user — cached here so all four
 * running processes share one token instead of each logging in independently.
 *
 * Values are always stored as strings. If you need to persist a number,
 * boolean, or JSON blob, serialise before writing and parse after reading.
 * Kept string-only to match the schema (`value String @db.Text`) and to
 * avoid a leaky "sometimes JSON, sometimes not" contract.
 */

/**
 * Read a value from SystemConfig.
 * Returns null if the key doesn't exist — callers decide what "missing" means
 * (e.g. Shiprocket token missing = need to log in fresh).
 */
export async function getSystemConfig(key: string): Promise<string | null> {
  const row = await prisma.systemConfig.findUnique({
    where: { key },
    select: { value: true },
  });
  return row?.value ?? null;
}

/**
 * Write a value to SystemConfig. Upsert — creates if new, replaces if exists.
 * `updatedAt` refreshes automatically via the @updatedAt directive in schema.
 */
export async function setSystemConfig(
  key: string,
  value: string
): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  logger.debug({ key }, "SystemConfig updated");
}