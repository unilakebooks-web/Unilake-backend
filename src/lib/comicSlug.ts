import type { Prisma } from "../generated/prisma/client.js";
import { ConflictError } from "../utils/errors.js";

// The readable address of a comic: /comic/<slug>. One place for the rule, used by the validators,
// the service and the tests. The admin form has a copy of the rule (lib/comicSlug.ts in the
// frontend): change both together.

export const COMIC_SLUG_MIN_LENGTH = 3;
export const COMIC_SLUG_MAX_LENGTH = 80;
export const COMIC_SLUG_FALLBACK = "comic";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// A comic id. A slug must never look like one, so that "id or slug" in one URL segment is never
// ambiguous: the public lookup treats this shape as an id and nothing else.
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Words that are, or may one day be, pages beside /comic/<slug>, or that the app uses itself.
export const COMIC_SLUG_RESERVED: readonly string[] = [
  "new",
  "edit",
  "admin",
  "api",
  "preview",
  "personalize",
  "share",
  "login",
  "dashboard",
  "comic",
  "comics",
  "blog",
  "blogs",
  "team",
  "contact",
  "about",
  "faq",
  "how-it-works",
  "how_it_work",
  "privacy",
  "terms",
  "refund",
  "sitemap",
  "robots",
  "favicon",
  "_next",
];

export const isUuidShaped = (value: string): boolean => UUID_SHAPE.test(value);

/** True when the text holds a NUL or another control character (U+0000 to U+001F, U+007F). */
export const hasControlCharacter = (value: string): boolean =>
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f]/.test(value);

/** Lower-cases and trims. Every slug is normalised before it is checked or compared. */
export const normalizeSlug = (input: string): string =>
  input.trim().toLowerCase();

/**
 * Why a slug is not allowed, or null when it is. Normalises first, so "My-Book " is judged as
 * "my-book".
 */
export function validateSlug(input: string): string | null {
  const slug = normalizeSlug(input);

  if (slug === "") return "Slug cannot be empty";
  if (slug.length < COMIC_SLUG_MIN_LENGTH) {
    return `Slug must be at least ${COMIC_SLUG_MIN_LENGTH} characters`;
  }
  if (slug.length > COMIC_SLUG_MAX_LENGTH) {
    return `Slug must be at most ${COMIC_SLUG_MAX_LENGTH} characters`;
  }
  if (!SLUG_PATTERN.test(slug)) {
    return "Slug can only use lower case letters, numbers and single hyphens, and cannot start or end with a hyphen";
  }
  if (isUuidShaped(slug)) return "Slug cannot look like an id";
  if (COMIC_SLUG_RESERVED.includes(slug)) {
    return `"${slug}" is reserved. Pick another slug`;
  }
  return null;
}

/**
 * A title as a slug base: lower case, every run of characters outside a-z0-9 becomes one hyphen,
 * hyphens trimmed, cut at `maxLength` and trimmed again. Empty when nothing is left (a Devanagari
 * title, for example): the caller falls back to COMIC_SLUG_FALLBACK.
 */
export function slugifyTitle(
  title: string,
  maxLength: number = COMIC_SLUG_MAX_LENGTH
): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
}

type SlugClient = Pick<Prisma.TransactionClient, "comic" | "comicSlugHistory">;

/** Who holds a slug: a comic as its current slug, or a comic as one of its old slugs. */
export type SlugOwner = { comicId: string; source: "current" | "history" };

/**
 * The owner of a slug among ALL comics (drafts, unpublished and retired included) and all slug
 * history rows, or null when it is free. A slug is "free" only when neither holds it.
 */
export async function findSlugOwner(
  client: SlugClient,
  slug: string
): Promise<SlugOwner | null> {
  const comic = await client.comic.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (comic) return { comicId: comic.id, source: "current" };

  const old = await client.comicSlugHistory.findUnique({
    where: { oldSlug: slug },
    select: { comicId: true },
  });
  if (old) return { comicId: old.comicId, source: "history" };

  return null;
}

// Bounded rather than a while(true), like the blog slug code: a title that somehow collides this
// many times should fail loudly, not spin.
const MAX_SLUG_ATTEMPTS = 50;

/**
 * A free slug for a title: the slugified title (or "comic" when that is empty, too short, an id
 * shape or a reserved word), then -2, -3 ... until neither a comic nor an old slug holds it. The
 * base is cut so that base plus suffix never passes the 80 characters.
 */
export async function generateFreeComicSlug(
  client: SlugClient,
  title: string
): Promise<string> {
  let base = slugifyTitle(title);
  if (validateSlug(base) !== null) base = COMIC_SLUG_FALLBACK;

  let candidate = base;
  let suffix = 2;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    if (!(await findSlugOwner(client, candidate))) return candidate;

    const tail = `-${suffix}`;
    candidate = `${base.slice(0, COMIC_SLUG_MAX_LENGTH - tail.length).replace(/-+$/, "")}${tail}`;
    suffix++;
  }

  throw new ConflictError(
    "Could not generate a unique slug for this title. Enter a slug by hand."
  );
}
