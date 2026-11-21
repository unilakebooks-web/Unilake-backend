import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../config/env.js";
import { logger } from "./logger.js";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "fs/promises";

// This single S3 instace will bee able to deal with both the public and private bucketconfiguration
export const r2Client = new S3Client({
  region: "auto", // this will automatically find the best region for the connections
  endpoint: config.r2.endpoint,
  credentials: {
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
  requestChecksumCalculation: "WHEN_REQUIRED", // this command right here is for the checking necessary configuration addotion for modern versions of the aws sdk to ensure that checksum headers map perfectly to he R@'s features set
});

/**
 * Uploads a raw file buffer directly to the specified Cloudflare R2 bucket.
 * * @param bucket - Targets either the 'public' or 'private' bucket defined in the environment config
 * @param key - The unique file path/name inside the destination bucket
 * @param buffer - The raw binary data of the file
 * @param contentType - The standard MIME type of the file (e.g., 'image/png', 'application/pdf')
 * @param options.contentDisposition - Optional Content-Disposition stored on the object.
 *   R2 returns it on every GET, which is how a download gets a real filename instead
 *   of the key's last segment (used for print PDFs — see utils/pdfFilename.ts).
 *   Must be plain ASCII; omit it and the object is stored exactly as before.
 */

export const uploadFile = async (
  bucket: "public" | "private",
  key: string,
  buffer: Buffer,
  contentType: string,
  options?: { contentDisposition?: string }
): Promise<void> => {
  const targetBucketName = bucket === "public" ? config.r2.publicBucket : config.r2.privateBucket;
    logger.debug(`Public bucket name : ${config.r2.publicBucket}`)
    logger.debug(`private bucket name : ${config.r2.privateBucket}`)

  logger.info(
    {
      bucket: targetBucketName,
      key,
      contentType,
      contentDisposition: options?.contentDisposition,
    },
    "Initiating file upload to Cloudflare R2"
  );

  const command = new PutObjectCommand({
    Bucket: targetBucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    // undefined is omitted from the request, so every other caller is unchanged.
    ContentDisposition: options?.contentDisposition,
  });

  await r2Client.send(command);

  logger.info(
    { bucket: targetBucketName, key },
    "File successfully uploaded to Cloudflare R2"
  );
};

/**
 * Generates the permanent public URL string for an asset inside the public bucket.
 * This method runs strictly in memory with no asynchronous R2 API overhead.
 * * @param key - The unique file path/name inside the public bucket
 * @returns The fully qualified public URL string
 */
export const getPublicUrl = (key: string): string => {
  const cleanBase = config.r2.publicUrlBase.replace(/\/$/, "");
  const cleanKey = key.replace(/^\//, "");

  return `${cleanBase}/${cleanKey}`;
};

/**
 * Extracts the R2 object key back out of a stored public URL.
 * The exact inverse of getPublicUrl().
 *
 * NOTE: intentionally has no callers yet. This exists for the SD worker, which
 * reads `Page.artworkUrl` / `Page.maskUrl` (stored as full public URLs) but needs
 * the raw key to download the file via downloadFileToLocalPath(). Do NOT delete
 * as dead code.
 *
 * @param url - A full public URL previously produced by getPublicUrl()
 * @returns The object key inside the public bucket
 */
export const getKeyFromPublicUrl = (url: string): string => {
  const cleanBase = config.r2.publicUrlBase.replace(/\/$/, "");

  return url.replace(`${cleanBase}/`, "");
};

/**
 * Generates a temporary, cryptographically signed URL for reading or downloading
 * an asset from the private bucket.
 * * @param key - The unique file path/name inside the private bucket
 * @param expirySeconds - Time window in seconds before the link automatically expires
 * @returns A promise that resolves to the signed URL string
 */

export const getSignedDownloadUrl = async (
  key: string,
  expirySeconds: number
): Promise<string> => {
  logger.info(
    { bucket: config.r2.privateBucket, key, expirySeconds },
    "Generating secure signed download URL for private asset"
  );

  const command = new GetObjectCommand({
    Bucket: config.r2.privateBucket,
    Key: key,
  });

  const signedUrl = await getSignedUrl(r2Client, command, {
    expiresIn: expirySeconds,
  });

  return signedUrl;
};

/**
 * Generates a temporary, cryptographically signed PUT URL that allows the frontend
 * to upload a file directly to either the public or private Cloudflare R2 bucket.
 * * @param bucket - Targets either the 'public' or 'private' bucket name from the environment config
 * @param key - The destination path and unique file name inside the bucket
 * @param contentType - The explicit MIME type expected during upload (e.g., 'image/jpeg', 'font/woff2')
 * @param expirySeconds - Time window in seconds before the link automatically expires
 * @returns A promise that resolves to the signed PUT upload URL string
 */

export const getSignedUploadUrl = async (
  bucket: "public" | "private",
  key: string,
  contentType: string,
  expirySeconds: number
): Promise<string> => {
  const targetBucketName = bucket === "public" ? config.r2.publicBucket : config.r2.privateBucket;

  logger.info(
    { bucket: targetBucketName, key, contentType, expirySeconds },
    "Generating secure presigned PUT upload URL"
  );

  const command = new PutObjectCommand({
    Bucket: targetBucketName,
    Key: key,
    ContentType: contentType, // Enforces that the client sends the exact content type specified
  });

  const signedUrl = await getSignedUrl(r2Client, command, {
    expiresIn: expirySeconds,
  });
  return signedUrl;
};

/**
 * Permanently deletes a file from the specified Cloudflare R2 bucket.
 * * @param bucket - Targets either the 'public' or 'private' bucket name from the environment config
 * @param key - The exact file path/name inside the target bucket to be deleted
 * @returns A promise that resolves when the deletion operation finishes
 */

export const deleteFile = async (
  bucket: "public" | "private",
  key: string
): Promise<void> => {
  const targetBucketName =
    bucket === "public" ? config.r2.publicBucket : config.r2.privateBucket;

  logger.info(
    { bucket: targetBucketName, key },
    "Initiating file deletion from Cloudflare R2"
  );

  const command = new DeleteObjectCommand({
    Bucket: targetBucketName,
    Key: key,
  });

  await r2Client.send(command);

  logger.info(
    { bucket: targetBucketName, key },
    "File successfully deleted from Cloudflare R2"
  );
};



/**
 * Downloads an object from R2 straight into an in-memory Buffer.
 *
 * Preferred over downloadFileToLocalPath() when the bytes are only needed
 * transiently (e.g. probing image dimensions with Sharp) — avoids a temp file
 * write/read/cleanup cycle.
 *
 * @param bucket - Targets either the 'public' or 'private' bucket from config
 * @param key - The object key inside that bucket
 * @returns The object's raw bytes
 */
export const downloadFileToBuffer = async (
  bucket: "public" | "private",
  key: string
): Promise<Buffer> => {
  const targetBucketName =
    bucket === "public" ? config.r2.publicBucket : config.r2.privateBucket;

  logger.debug(
    { bucket: targetBucketName, key },
    "Downloading object from Cloudflare R2 into memory"
  );

  const response = await r2Client.send(
    new GetObjectCommand({ Bucket: targetBucketName, Key: key })
  );

  const bodyBytes = await response.Body!.transformToByteArray();

  return Buffer.from(bodyBytes);
};

// ── Share routes (feature 14) ────────────────────────────────────────────────────────────

/** Thrown when an object is bigger than the caller allows, or does not say how big it is. */
export class StorageObjectRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageObjectRefusedError";
  }
}

const isMissingObject = (error: unknown): boolean => {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};

/** Size and ETag of a public-bucket object, or null when it does not exist. Any other failure is thrown. */
export const headObjectChecked = async (
  key: string,
  timeoutMs: number
): Promise<{ contentLength: number; etag: string | undefined } | null> => {
  try {
    const response = await r2Client.send(
      new HeadObjectCommand({ Bucket: config.r2.publicBucket, Key: key }),
      { abortSignal: AbortSignal.timeout(timeoutMs) }
    );
    return { contentLength: response.ContentLength ?? 0, etag: response.ETag };
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
};

export interface OpenedObject {
  contentLength: number;
  etag: string | undefined;
  /** Reads the body into memory: at most `maxBytes`, within `readDeadlineMs`. Call it or `discard`, once. */
  read: () => Promise<Buffer>;
  discard: () => void;
}

/**
 * Opens a public-bucket object for a bounded read. The caller learns the size first (so it can reserve memory)
 * and then reads. Returns null when the object does not exist. An object without a size, or bigger than
 * `maxBytes`, is refused. The first-byte timeout stops once the headers arrive; the body has its own deadline.
 */
export const openObjectChecked = async (
  key: string,
  options: { maxBytes: number; firstByteTimeoutMs: number; readDeadlineMs: number }
): Promise<OpenedObject | null> => {
  const controller = new AbortController();
  const firstByteTimer = setTimeout(() => controller.abort(), options.firstByteTimeoutMs);
  let response;
  try {
    response = await r2Client.send(
      new GetObjectCommand({ Bucket: config.r2.publicBucket, Key: key }),
      { abortSignal: controller.signal }
    );
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  } finally {
    clearTimeout(firstByteTimer);
  }

  const body = response.Body as
    | (NodeJS.ReadableStream & { destroy?: () => void; transformToByteArray?: () => Promise<Uint8Array> })
    | undefined;
  const discard = () => {
    controller.abort();
    body?.destroy?.();
  };
  const contentLength = response.ContentLength;
  if (!body || contentLength === undefined || contentLength === null) {
    discard();
    throw new StorageObjectRefusedError("The object does not report its size");
  }
  if (contentLength > options.maxBytes) {
    discard();
    throw new StorageObjectRefusedError("The object is larger than allowed");
  }

  const read = async (): Promise<Buffer> => {
    const deadline = setTimeout(discard, options.readDeadlineMs);
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buffer.length;
        // Counted as it arrives: the size header is not trusted on its own.
        if (total > options.maxBytes) {
          discard();
          throw new StorageObjectRefusedError("The object is larger than allowed");
        }
        chunks.push(buffer);
      }
      // A body that is not the size the object reported was cut short or is not this object.
      if (total !== contentLength) throw new StorageObjectRefusedError("The object is not the size it reported");
      return Buffer.concat(chunks, total);
    } finally {
      clearTimeout(deadline);
    }
  };

  return { contentLength, etag: response.ETag, read, discard };
};

/** Objects deleted at the same time by deletePrefix. */
const DELETE_PREFIX_PARALLEL = 10;

/** The only prefixes deletePrefix accepts: one session's folder. */
const SESSION_PREFIX_PATTERN =
  /^sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/;

/**
 * Deletes every object under one session's folder ("sessions/<uuid>/") in the given bucket and
 * returns how many it deleted. Refuses any other prefix, so a wrong argument cannot empty a bucket.
 * Pages through the listing and deletes ten keys at a time with DeleteObjectCommand (the batch
 * delete is not verified against R2 with our checksum setting).
 */
export async function deletePrefix(
  bucket: "public" | "private",
  prefix: string
): Promise<number> {
  if (!SESSION_PREFIX_PATTERN.test(prefix)) {
    throw new Error("deletePrefix only deletes a session folder");
  }

  const targetBucketName =
    bucket === "public" ? config.r2.publicBucket : config.r2.privateBucket;

  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const page = await r2Client.send(
      new ListObjectsV2Command({
        Bucket: targetBucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const keys = (page.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => !!key && key.startsWith(prefix));
    // A few at a time: one by one is too slow for a book's worth of files inside the sweep's time limit.
    for (let i = 0; i < keys.length; i += DELETE_PREFIX_PARALLEL) {
      await Promise.all(
        keys.slice(i, i + DELETE_PREFIX_PARALLEL).map((key) =>
          r2Client.send(
            new DeleteObjectCommand({ Bucket: targetBucketName, Key: key })
          )
        )
      );
      deleted += Math.min(DELETE_PREFIX_PARALLEL, keys.length - i);
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  logger.info(
    { bucket: targetBucketName, prefix, deleted },
    "Deleted a session folder from Cloudflare R2"
  );

  return deleted;
}

// ---------------------------------------------------------------------------------------------
// Automatic data deletion (feature 6). Used only by services/dataDeletion.service.ts. Every
// helper takes an abort signal (the engine passes one with its own deadline) and every delete is
// checked against an allow-list, so a wrong argument cannot reach anything else.
// ---------------------------------------------------------------------------------------------

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The only listing prefixes the engine uses: a session folder, a session's photo objects, a canary folder. */
const DELETION_LIST_PREFIX_PATTERNS = [
  new RegExp(`^sessions/${UUID}/$`),
  new RegExp(`^sessions/${UUID}/photo-$`),
  new RegExp(`^pdfs/${UUID}\\.pdf$`),
  new RegExp(`^comics/[^/]+/(pages|fonts)/$`),
];

/** The only keys the engine deletes. A comic's video and LoRA keys are exact keys in shared folders. */
const DELETION_KEY_PATTERNS = [
  new RegExp(`^sessions/${UUID}/.+$`),
  new RegExp(`^pdfs/${UUID}\\.pdf$`),
  new RegExp(`^comics/[^/]+/(pages|fonts)/.+$`),
  /^comics\/videos\/[^/]+$/,
  /^comics\/lora\/[^/]+$/,
];

export const isDeletionListPrefix = (prefix: string): boolean =>
  !prefix.includes("..") && DELETION_LIST_PREFIX_PATTERNS.some((pattern) => pattern.test(prefix));

export const isDeletionKey = (key: string): boolean =>
  !key.includes("..") && DELETION_KEY_PATTERNS.some((pattern) => pattern.test(key));

const bucketName = (bucket: "public" | "private"): string =>
  bucket === "public" ? config.r2.publicBucket : config.r2.privateBucket;

/** The key of an order's final PDF (the same shape compilePdfForSession writes). */
export const pdfKeyFor = (sessionId: string): string => {
  if (!new RegExp(`^${UUID}$`).test(sessionId)) {
    throw new Error("pdfKeyFor needs a session id");
  }
  return `pdfs/${sessionId}.pdf`;
};

export interface ObjectsPage {
  keys: string[];
  /** Set while the listing is truncated: pass it back to read the next page. */
  next: string | undefined;
}

/** One page (up to 1,000 keys) of the objects under an allowed prefix. */
export async function listObjectsPage(
  bucket: "public" | "private",
  prefix: string,
  continuationToken: string | undefined,
  signal?: AbortSignal
): Promise<ObjectsPage> {
  if (!isDeletionListPrefix(prefix)) {
    throw new Error("listObjectsPage: prefix is not allowed");
  }
  const page = await r2Client.send(
    new ListObjectsV2Command({
      Bucket: bucketName(bucket),
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }),
    { abortSignal: signal }
  );
  const keys = (page.Contents ?? [])
    .map((object) => object.Key)
    .filter((key): key is string => !!key && key.startsWith(prefix));
  // Continue on IsTruncated alone: a page can be short or even empty and still truncated.
  return { keys, next: page.IsTruncated ? page.NextContinuationToken : undefined };
}

/** How many objects sit under an allowed prefix. */
export async function countPrefix(
  bucket: "public" | "private",
  prefix: string,
  signal?: AbortSignal
): Promise<number> {
  let total = 0;
  let token: string | undefined;
  do {
    const page = await listObjectsPage(bucket, prefix, token, signal);
    total += page.keys.length;
    token = page.next;
  } while (token);
  return total;
}

/** Whether an object exists (a missing object is false; any other failure throws). */
export async function objectExists(
  bucket: "public" | "private",
  key: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    await r2Client.send(
      new HeadObjectCommand({ Bucket: bucketName(bucket), Key: key }),
      { abortSignal: signal }
    );
    return true;
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      err.name === "NotFound" ||
      err.name === "NoSuchKey" ||
      err.$metadata?.httpStatusCode === 404
    ) {
      return false;
    }
    throw error;
  }
}

/** Deletes one object. Refuses any key that is not on the allow-list. */
export async function deleteKeyChecked(
  bucket: "public" | "private",
  key: string,
  signal?: AbortSignal
): Promise<void> {
  if (!isDeletionKey(key)) {
    throw new Error("deleteKeyChecked: key is not allowed");
  }
  await r2Client.send(
    new DeleteObjectCommand({ Bucket: bucketName(bucket), Key: key }),
    { abortSignal: signal }
  );
}

/** Uploads a tiny object (the canary's). */
export async function putObjectChecked(
  bucket: "public" | "private",
  key: string,
  body: Buffer,
  signal?: AbortSignal
): Promise<void> {
  if (!isDeletionKey(key)) {
    throw new Error("putObjectChecked: key is not allowed");
  }
  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucketName(bucket),
      Key: key,
      Body: body,
      ContentType: "text/plain",
    }),
    { abortSignal: signal }
  );
}

export async function downloadFileToLocalPath(
  bucket: string,
  key: string,
  localPath: string
): Promise<void> {
  const response = await r2Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );

  const bodyBytes = await response.Body!.transformToByteArray();
  await fs.writeFile(localPath, bodyBytes);
}