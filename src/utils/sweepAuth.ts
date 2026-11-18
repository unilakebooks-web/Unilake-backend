import crypto from "node:crypto";

/**
 * True only when a secret is configured AND the caller sent exactly that secret.
 * Both sides are hashed first so the comparison always sees buffers of equal
 * length and takes the same time wherever they differ.
 */
export function isValidSweepSecret(
  provided: string | undefined,
  configured: string
): boolean {
  if (!configured || !provided) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}
