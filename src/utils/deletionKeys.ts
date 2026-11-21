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
