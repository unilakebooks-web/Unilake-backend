// will hold the HTTP client for RunPod

import { config } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import { AppError } from "../../../utils/errors.js";

const RUNPOD_BASE_URL = "https://api.runpod.ai/v2";

// Polling settings — DECISIONS locks these:
//   - Interval 5s: RunPod recommends >=1s, warm jobs take ~90s, so ~18 polls typical
//   - Max attempts: safety bound in case a job never resolves. 200 * 5s = ~17 min.
//     The endpoint's own executionTimeout is 600s so a real job should FAIL long
//     before we hit this — but we still bound the loop in case of a stuck response.
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 200;

type RunPodStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

// All four response shapes flattened into one type.
// Some fields only appear in certain states — hence the `?`.
type RunPodStatusResponse = {
  id: string;
  status: RunPodStatus;
  delayTime?: number;
  executionTime?: number;
  workerId?: string;
  output?: {
    images: Array<{
      data: string; // base64
      filename: string;
      type: "base64";
    }>;
  };
  error?: string;
};

type RunPodSubmitResponse = {
  id: string;
  status: string;
};

export type SubmitParams = {
  workflow: object; // the patched workflow from buildWorkflow()
  images: Array<{
    name: string; // MUST match filenames used in the workflow's LoadImage nodes
    image: string; // raw base64, no data URI prefix
  }>;
};

export type JobResult = {
  imageBuffer: Buffer; // the face-swapped result
  jobId: string; // for logging/traceability
  delayTimeMs: number;
  executionTimeMs: number;
};


// Retry settings for transient failures during status polling.
// 3 attempts total (1 real try + 2 retries) with short backoff — 500ms, 1000ms.
// The total worst-case extra delay per poll is 1.5s, well under the 5s poll
// interval, so retries never cascade into slower polling.
const FETCH_STATUS_MAX_ATTEMPTS = 3;
const FETCH_STATUS_RETRY_DELAYS_MS = [500, 1000];

/**
 * Decides whether an error is worth retrying.
 *
 * Retry:  network failures (fetch threw), HTTP 5xx, HTTP 429 (rate limit).
 * Skip:   HTTP 4xx (auth wrong, job not found, malformed request) — these
 *         will never succeed on retry, so retrying just wastes time.
 *
 * A network failure is a `TypeError` thrown by fetch itself. An HTTP failure
 * is an `AppError` we threw with the status embedded in the message. We look
 * at both.
 */
function isRetryableError(err: unknown): boolean {
  // Network-layer failure — fetch itself threw before we got any response.
  // TypeError is what native fetch throws on DNS/TCP/connection issues.
  if (err instanceof TypeError) return true;

  // HTTP-layer failure — we threw an AppError with the status in the message.
  if (err instanceof AppError) {
    // Match "HTTP 5xx" or "HTTP 429" in the error message.
    // Any other 4xx is a permanent error — don't retry.
    return /HTTP (5\d{2}|429)/.test(err.message);
  }

  // Unknown error shape — safer not to retry.
  return false;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send the job to RunPod's /run endpoint. Returns immediately with a jobId.
 * Does NOT wait for the job to complete — that's what pollUntilDone does.
 */

async function submit(params: SubmitParams): Promise<string> {
  const url = `${RUNPOD_BASE_URL}/${config.runpod.endpointId}/run`;

  const payload = {
    input: {
      workflow: params.workflow,
      images: params.images,
    },
  };

  logger.debug(
    { url, imageCount: params.images.length },
    "Submitting job to RunPod"
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.runpod.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error(
      { status: res.status, body: body.substring(0, 500) },
      "RunPod /run rejected the submission"
    );
    throw new AppError(
      `RunPod submission failed with status ${res.status}: ${body.substring(0, 200)}`,
      502,
      "RUNPOD_SUBMIT_FAILED"
    );
  }

  const data = (await res.json()) as RunPodSubmitResponse;

  logger.info(
    { jobId: data.id, initialStatus: data.status },
    "RunPod job submitted"
  );
  return data.id;
}

/**
 * One raw HTTP call to RunPod's /status endpoint. No retry logic — that's
 * layered on top in fetchStatus below. Kept separate so the retry wrapper
 * stays readable and this function is easy to reason about on its own.
 */
async function fetchStatusOnce(jobId: string): Promise<RunPodStatusResponse> {
  const url = `${RUNPOD_BASE_URL}/${config.runpod.endpointId}/status/${jobId}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.runpod.apiKey}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error(
      { jobId, status: res.status, body: body.substring(0, 500) },
      "RunPod /status returned non-OK"
    );
    throw new AppError(
      `RunPod status check failed with HTTP ${res.status}`,
      502,
      "RUNPOD_STATUS_FAILED"
    );
  }
  return (await res.json()) as RunPodStatusResponse;
}

/**
 * Status check for a submitted job, with retries for transient failures.
 *
 * Fixes audit 9.8: a single network blip on ANY of the ~200 status polls
 * per job used to throw immediately, which bubbled to BullMQ and triggered
 * a full-job retry — submitting a brand-new RunPod job while the original
 * kept running and burning GPU. You paid for both.
 *
 * Now: transient failures retry up to 2 extra times with 500ms/1000ms
 * backoff before giving up. Permanent failures (4xx other than 429) fail
 * immediately as before — retrying a bad auth key or a missing job would
 * just waste time.
 */
async function fetchStatus(jobId: string): Promise<RunPodStatusResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= FETCH_STATUS_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchStatusOnce(jobId);
    } catch (err) {
      lastError = err;

      // Permanent error — no point retrying. Re-throw exactly as thrown.
      if (!isRetryableError(err)) {
        throw err;
      }

      // Out of attempts — surface the last error to the caller. BullMQ will
      // then retry the whole job, but this only happens after 3 consecutive
      // real failures, which is a genuine RunPod outage, not a blip.
      if (attempt === FETCH_STATUS_MAX_ATTEMPTS) {
        logger.error(
          { jobId, attempt, err },
          "[RunPod] fetchStatus exhausted retries — surfacing to worker"
        );
        throw err;
      }

      // Retryable, and we have attempts left — log and wait.
      const delayMs = FETCH_STATUS_RETRY_DELAYS_MS[attempt - 1]!;
      logger.warn(
        { jobId, attempt, delayMs, err },
        "[RunPod] Transient failure on status poll — retrying"
      );
      await sleep(delayMs);
    }
  }

  // Unreachable — the loop either returns, throws, or hits its final-attempt
  // throw above. This is here to keep TypeScript happy about the return type.
  throw lastError;
}

/**
 * Poll RunPod's status endpoint every POLL_INTERVAL_MS until the job resolves.
 * Throws on FAILED, CANCELLED, or if we exhaust MAX_POLL_ATTEMPTS.
 */

async function pollUntilDone(jobId: string): Promise<RunPodStatusResponse> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const response = await fetchStatus(jobId);

    if (response.status === "COMPLETED") {
      logger.info(
        {
          jobId,
          attempts: attempt,
          delayTimeMs: response.delayTime,
          executionTimeMs: response.executionTime,
        },
        "RunPod job completed"
      );
      return response;
    }
    if (response.status === "FAILED" || response.status === "CANCELLED") {
      const errorMessage = response.error ?? "Unknown RunPod failure";
      logger.error(
        { jobId, status: response.status, error: errorMessage },
        "RunPod job did not complete successfully"
      );
      throw new AppError(
        `RunPod job ${response.status.toLowerCase()}: ${errorMessage}`,
        502,
        "RUNPOD_JOB_FAILED"
      );
    }

    // Still IN_QUEUE or IN_PROGRESS — keep waiting
    logger.debug(
      { jobId, attempt, status: response.status },
      "RunPod job still running"
    );
    await sleep(POLL_INTERVAL_MS);
  }

  // Ran out of attempts
  logger.error(
    { jobId, maxAttempts: MAX_POLL_ATTEMPTS },
    "RunPod polling exhausted attempts without resolution"
  );
  throw new AppError(
    `RunPod job did not complete within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`,
    504,
    "RUNPOD_POLL_TIMEOUT"
  );
}

/**
 * Decode RunPod's base64 output back into a Buffer.
 * The response's images[0].data is raw base64 — no `data:` URI prefix.
 */
function decodeResultImage(response: RunPodStatusResponse): Buffer {
  const image = response.output?.images?.[0];
  if (!image?.data) {
    logger.error({ response }, "RunPod COMPLETED response missing image data");
    throw new AppError(
      "RunPod completed but returned no image in output.images[0].data",
      502,
      "RUNPOD_MALFORMED_OUTPUT",
    );
  }

  return Buffer.from(image.data, "base64");
}

/**
 * Submit a job to RunPod, poll until it finishes, and return the result image.
 * This is the ONLY function Part E should import from this file.
 */
export async function submitAndAwaitResult(params: SubmitParams): Promise<JobResult> {
  const jobId = await submit(params);
  const finalResponse = await pollUntilDone(jobId);
  const imageBuffer = decodeResultImage(finalResponse);

  return {
    imageBuffer,
    jobId,
    delayTimeMs: finalResponse.delayTime ?? 0,
    executionTimeMs: finalResponse.executionTime ?? 0,
  };
}
