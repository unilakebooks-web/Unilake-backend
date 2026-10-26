import type { CoverType } from "../generated/prisma/client.js";

/**
 * Download name for a compiled print PDF.
 *
 * Format: `[ChildName]_[Hardcover|Softcover]_[Book_Name]_[serial].pdf`, e.g.
 * "Aarav_Hardcover_The_Magic_Treehouse_3f6a1c2e.pdf". The serial is the first
 * 8 characters of Order.id — the same short id the admin order list shows — so
 * a downloaded file can be matched back to its order at a glance.
 *
 * This is the DOWNLOAD name only. The R2 key stays `pdfs/{sessionId}.pdf`
 * (unguessable, no child name in a public URL) and the PDF's internal title
 * stays the comic title. The name reaches the browser through the
 * Content-Disposition header stored on the object at upload — see
 * buildAttachmentContentDisposition below.
 *
 * Not the same as buildShiprocketProductName (shiprocket.service.ts): that one
 * keeps spaces and the raw cover enum because it is printed on a label, not
 * saved to a filesystem.
 */

const SERIAL_LENGTH = 8;

/**
 * Cap on everything before the serial. Windows refuses paths over 260
 * characters, and the file lands inside the admin's Downloads folder, so the
 * name itself has to leave room for the folder path.
 */
const MAX_NAME_PREFIX_LENGTH = 140;

const COVER_LABEL: Record<CoverType, string> = {
  HARDCOVER: "Hardcover",
  SOFTCOVER: "Softcover",
};

/**
 * Make one segment filesystem-safe: drop characters Windows forbids in
 * filenames (and control characters), turn whitespace into underscores, and
 * tidy the underscores so a stray space never produces "__" or a leading "_".
 * Non-ASCII letters are kept — the header carries them via `filename*`.
 */
function cleanSegment(value: string | null | undefined): string {
  if (!value) return "";

  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Truncate by code point so a non-BMP character is never cut in half. */
function truncate(value: string, maxLength: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) return value;
  return chars.slice(0, maxLength).join("").replace(/_+$/, "");
}

export function buildPdfDownloadFilename(params: {
  childName: string | null;
  coverType: CoverType;
  comicTitle: string;
  orderId: string;
}): string {
  // An empty segment is dropped rather than left as "__". childName is
  // required before generation, so in practice only a title made entirely of
  // forbidden characters could ever hit this.
  const prefix = [
    cleanSegment(params.childName),
    COVER_LABEL[params.coverType],
    cleanSegment(params.comicTitle),
  ]
    .filter((segment) => segment.length > 0)
    .join("_");

  const serial = params.orderId.slice(0, SERIAL_LENGTH);

  return `${truncate(prefix, MAX_NAME_PREFIX_LENGTH)}_${serial}.pdf`;
}

/**
 * RFC 5987 value for `filename*`. encodeURIComponent leaves ' ( ) * ! alone,
 * but the RFC's attr-char set does not allow them, so they are encoded too.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Content-Disposition header that makes the browser download the file under
 * `filename` instead of the last segment of the URL.
 *
 * Two forms, because an HTTP header value must be plain ASCII and a child's
 * name may not be (e.g. typed in Devanagari):
 *   - filename*  — the full UTF-8 name, percent-encoded. Every current browser
 *                  prefers this when present.
 *   - filename   — an ASCII-only fallback for clients that don't read
 *                  filename*. Non-ASCII characters are dropped from it.
 *
 * Putting a raw non-ASCII name into the header would not just be ignored — it
 * would break the S3 request signature on upload.
 *
 * `attachment`, not `inline`: the admin download should save straight away,
 * and some browsers ignore the filename when saving from their inline viewer.
 */
export function buildAttachmentContentDisposition(filename: string): string {
  // Never empty in practice — the cover label and serial are always ASCII —
  // but the header must always carry a usable name, so guard anyway.
  const asciiFallback =
    filename
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/["\\]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_+/, "") || "book.pdf";

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}
