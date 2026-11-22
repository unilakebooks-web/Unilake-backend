import { config } from "../config/env.js";

// Public image hosts the stored URLs may use (the configured base, the r2.dev host and the images domain, see
// the memory of the 2026-11-17 domain change). A URL under any other host is not ours: never deleted, only listed.
const PUBLIC_HOST_SUFFIXES = [".r2.dev"];
const PUBLIC_HOSTS = ["images.unilakekids.com"];

/** The object key inside the public bucket of a stored public URL, or null when the URL is not one of ours. */
export function publicUrlToKey(url: string): string | null {
  const base = config.r2.publicUrlBase.replace(/\/$/, "");
  if (url.startsWith(`${base}/`)) {
    const key = url.slice(base.length + 1);
    return key === "" ? null : key;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const ours =
      PUBLIC_HOSTS.includes(host) ||
      PUBLIC_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
    if (!ours) return null;
    const key = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return key === "" ? null : key;
  } catch {
    return null;
  }
}

export interface RecordedKeys {
  /** Keys in the private bucket (the customer's photos). */
  privateKeys: string[];
  /** Keys in the public bucket (previews, stamped and final pages) that could be normalised. */
  publicKeys: string[];
  /** Stored URLs that are not ours: never deleted, never judged. */
  unknownUrls: number;
}

interface VersionUrls {
  textStampedUrl: string | null;
  displayImageUrl: string | null;
  finalImageUrl: string | null;
}

/** Every file key a session records: its photos and every URL of every page version, FAILED versions included. */
export function recordedSessionKeys(session: {
  rawPhotoUrls: string[];
  bestPhotoUrl: string | null;
  pageVersions: VersionUrls[];
}): RecordedKeys {
  const privateKeys = new Set<string>();
  for (const key of session.rawPhotoUrls) if (key) privateKeys.add(key);
  if (session.bestPhotoUrl) privateKeys.add(session.bestPhotoUrl);

  const publicKeys = new Set<string>();
  let unknownUrls = 0;
  for (const version of session.pageVersions) {
    for (const url of [
      version.textStampedUrl,
      version.displayImageUrl,
      version.finalImageUrl,
    ]) {
      if (!url) continue;
      const key = publicUrlToKey(url);
      if (key === null) unknownUrls += 1;
      else publicKeys.add(key);
    }
  }
  return {
    privateKeys: [...privateKeys],
    publicKeys: [...publicKeys],
    unknownUrls,
  };
}

/** True when a key lies inside the session's own folder. */
export const isInSessionFolder = (sessionId: string, key: string): boolean =>
  key.startsWith(`sessions/${sessionId}/`);

/**
 * Every column of schema.prisma that holds a URL or an object key and is read by keyReferencedElsewhere (dataDeletionEngine.service.ts), as
 * "Model.column". tests/unit/deletionKeyColumns.test.ts fails when the schema has a URL or key column that is in
 * neither this list nor IGNORED_URL_COLUMNS, so a new column is classified when it is added.
 */
export const SCANNED_URL_COLUMNS = [
  "Comic.coverThumbnailUrls",
  "Comic.previewVideoUrl",
  "Comic.loraFileUrl",
  "Page.artworkUrl",
  "Page.maskUrl",
  "Font.fileUrl",
  "Country.flagUrl",
  "HeroImage.imageUrl",
  "CustomerReview.videoUrl",
  "TeamMember.imageUrl",
  "HowItWorks.videoUrl",
  "HowItWorks.posterUrl",
  "Blog.coverImageUrl",
  "GoogleReview.imageUrl",
  "Comic.ogImageUrl",
  "Blog.ogImageUrl",
  "PageSeo.ogImageUrl",
];

/** URL and key columns that cannot name a comic's file, with the reason (checked against the schema by the same test). */
export const IGNORED_URL_COLUMNS: Record<string, string> = {
  "User.image":
    "an account picture from the sign-in provider, never a stored upload",
  "OrderSession.rawPhotoUrls":
    "customer photos under sessions/, never a comic key (the allow-list refuses that folder)",
  "OrderSession.bestPhotoUrl": "customer photo under sessions/",
  "PageVersion.textStampedUrl": "generated page under sessions/",
  "PageVersion.displayImageUrl": "generated page under sessions/",
  "PageVersion.finalImageUrl": "generated page under sessions/",
  "Order.pdfUrl": "the book PDF under pdfs/",
  "Order.pdfDownloadUrl": "a signed link to the PDF under pdfs/",
  "Order.trackingUrl": "the courier's tracking page",
  "Page.artworkFileName": "a file name shown to the admin, not a key",
  "Page.maskFileName": "a file name shown to the admin, not a key",
  "GoogleReview.imageAlt": "alt text, not a key",
  "TeamMember.linkedinUrl": "a link to another site",
  "TeamMember.instagramUrl": "a link to another site",
  "TeamMember.twitterUrl": "a link to another site",
  "SiteSetting.mapEmbedUrl": "a link to another site",
  "SiteSetting.instagramUrl": "a link to another site",
  "SiteSetting.facebookUrl": "a link to another site",
  "SiteSetting.twitterUrl": "a link to another site",
  "SiteSetting.youtubeUrl": "a link to another site",
  "SiteSetting.linkedinUrl": "a link to another site",
  "ReminderSetting.googleReviewUrl": "a link to another site",
  "Broadcast.buttonUrl": "a link in an email",
  "SystemConfig.key": "the name of a setting, not an object key",
  "Comic.coverThumbnailAlts": "alt text for the cover pictures, not a key",
  "HeroImage.imageAlt": "alt text, not a key",
  "TeamMember.imageAlt": "alt text, not a key",
  "HowItWorks.posterAlt": "alt text, not a key",
  "Blog.coverImageAlt": "alt text, not a key",
  "PageSeo.ogImageAlt": "alt text, not a key",
  "SiteSetting.blogAuthorInstagramUrl": "a link to another site",
  "SiteSetting.blogAuthorLinkedinUrl": "a link to another site",
};
