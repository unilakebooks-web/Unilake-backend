import { config } from "../config/env.js";
import { logger } from "./logger.js";
import { AppError, ValidationError } from "../utils/errors.js";
import { getSystemConfig, setSystemConfig } from "./systemConfig.js";

// ============================================================
// SHIPROCKET CLIENT
// ============================================================
//
// Sole entry point for talking to Shiprocket. Workers, webhook handler, and
// admin endpoints import from here — no other file makes raw fetch calls to
// Shiprocket. Same pattern as runpodClient.ts.
//
// Structure of the file:
//   - Constants & tunables at top
//   - Private types for raw Shiprocket responses
//   - Public types for what our callers see
//   - Private helpers: sleep, isRetryableError, shiprocketFetch (base wrapper)
//   - Auth: loginAndCacheToken, getAuthToken (both private)
//   - Public API functions (added in Section 3B)
//
// Auth token lifecycle:
//   Shiprocket tokens are valid for 10 days. We cache in SystemConfig so all
//   processes share one token. We refresh 12h before expiry to avoid a token
//   expiring mid-request. First request after a fresh boot triggers login;
//   subsequent requests reuse the cached token until it nears expiry.

const SHIPROCKET_BASE_URL = "https://apiv2.shiprocket.in/v1/external";

// Retry settings for transient failures on any Shiprocket call.
// 3 attempts total (1 real try + 2 retries) with progressive backoff.
// Retries apply to network errors and HTTP 5xx / 429 only — permanent 4xx
// failures throw immediately, same policy as runpodClient.
const MAX_FETCH_ATTEMPTS = 3;
const FETCH_RETRY_DELAYS_MS = [500, 1500];

// SystemConfig keys for the cached auth token.
const TOKEN_KEY = "shiprocket_token";
const TOKEN_EXPIRY_KEY = "shiprocket_token_expiry";

// How early (before actual expiry) to consider the token stale and refresh.
// Shiprocket tokens live 10 days; we refresh 12h early so a long-running
// request can never race with the token expiring mid-flight.
const TOKEN_REFRESH_MARGIN_MS = 12 * 60 * 60 * 1000; // 12 hours
// ============================================================
// PRIVATE HELPERS
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decides whether a Shiprocket failure is worth retrying.
 *
 * Retry:  network failures (fetch threw), HTTP 5xx, HTTP 429 (rate limit).
 * Skip:   HTTP 4xx other than 429 — auth wrong, malformed payload, pickup
 *         location inactive. These will never succeed on retry.
 *
 * Same policy as runpodClient's isRetryableError. AppError carries the
 * status embedded in its message; we match with a regex.
 */
function isRetryableError(err: unknown): boolean {
  // Network-layer failure — fetch itself threw before we got any response.
  if (err instanceof TypeError) return true;

  // HTTP-layer failure — we threw AppError with the status in the message.
  if (err instanceof AppError) {
    return /HTTP (5\d{2}|429)/.test(err.message);
  }

  return false;
}

/**
 * Base HTTP wrapper for all Shiprocket calls.
 *
 * Every public function (createOrder, assignAwb, etc.) goes through this.
 * Responsibilities:
 *   - Prepend base URL
 *   - Inject Authorization: Bearer <token> header (via getAuthToken)
 *   - JSON-encode request body
 *   - Retry transient failures (network / 5xx / 429) with backoff
 *   - Throw typed AppError on permanent failures
 *   - Parse and return JSON response as unknown (each caller narrows the type)
 *
 * The `path` argument is the endpoint path AFTER the base URL, e.g.
 *   "/orders/create/adhoc"  →  https://apiv2.shiprocket.in/v1/external/orders/create/adhoc
 *
 * `skipAuth: true` is used only by loginAndCacheToken (which cannot depend on
 * itself). Every other call passes it as false / omits it.
 */
async function shiprocketFetch(
  path: string,
  options: {
    method: "GET" | "POST";
    body?: object;
    skipAuth?: boolean;
    errorCode: string; // e.g. "SHIPROCKET_CREATE_ORDER_FAILED"
  }
): Promise<unknown> {
  const url = `${SHIPROCKET_BASE_URL}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!options.skipAuth) {
    const token = await getAuthToken();
    headers.Authorization = `Bearer ${token}`;
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: options.method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      if (!res.ok) {
        const body = await res.text();
        logger.error(
          {
            path,
            method: options.method,
            status: res.status,
            body: body.substring(0, 500),
          },
          "Shiprocket API returned non-OK"
        );
        throw new AppError(
          `Shiprocket ${path} failed with HTTP ${res.status}: ${body.substring(0, 200)}`,
          502,
          options.errorCode
        );
      }

      // 204 No Content — Shiprocket's cancel endpoint returns this on success.
      // res.json() would throw on an empty body, so short-circuit here.
      if (res.status === 204) {
        return null;
      }

      return await res.json();
    } catch (err) {
      lastError = err;

      // Permanent error — no point retrying. Re-throw exactly as thrown.
      if (!isRetryableError(err)) {
        throw err;
      }

      // Out of attempts — surface the last error.
      if (attempt === MAX_FETCH_ATTEMPTS) {
        logger.error(
          { path, attempt, err },
          "[Shiprocket] fetch exhausted retries — surfacing"
        );
        throw err;
      }

      // Retryable, and we have attempts left — log and wait.
      const delayMs = FETCH_RETRY_DELAYS_MS[attempt - 1]!;
      logger.warn(
        { path, attempt, delayMs, err },
        "[Shiprocket] Transient failure — retrying"
      );
      await sleep(delayMs);
    }
  }

  // Unreachable — loop above always returns or throws.
  throw lastError;
}

// ============================================================
// AUTH TOKEN LIFECYCLE
// ============================================================

/**
 * Response shape from POST /auth/login. Based on Shiprocket docs — the
 * response includes a token string; we treat it as opaque and rely on
 * TOKEN_REFRESH_MARGIN_MS for expiry rather than parsing any expiry field
 * they return (some docs mention `expires_in`, some don't — safer to compute
 * our own expiry timestamp).
 */
type LoginResponse = {
  token?: string;
  // Shiprocket also returns id, first_name, last_name, email, company_id, etc.
  // We don't need any of those.
};

/**
 * Fresh login. Hits POST /auth/login with credentials from env, receives the
 * token, computes our own expiry timestamp (now + 10 days), writes both to
 * SystemConfig, returns the token.
 *
 * Called by getAuthToken when the cache is missing or stale. Also called on
 * a forced refresh if a downstream call gets a 401 (planned handling — not
 * implemented yet; will land in Section 3B if we see it in practice).
 */
async function loginAndCacheToken(): Promise<string> {
  logger.info("Shiprocket: refreshing auth token via /auth/login");

  const raw = await shiprocketFetch("/auth/login", {
    method: "POST",
    body: {
      email: config.shiprocket.email,
      password: config.shiprocket.password,
    },
    skipAuth: true,
    errorCode: "SHIPROCKET_AUTH_FAILED",
  });

  const response = raw as LoginResponse;

  if (!response.token || typeof response.token !== "string") {
    logger.error({ response }, "Shiprocket login returned no token");
    throw new AppError(
      "Shiprocket login succeeded but response contained no token",
      502,
      "SHIPROCKET_AUTH_MALFORMED"
    );
  }

  // Compute expiry as now + 10 days. Shiprocket documents a 240-hour lifetime.
  // We store the actual expiry, then refresh TOKEN_REFRESH_MARGIN_MS before it.
  const expiresAt = new Date(Date.now() + 240 * 60 * 60 * 1000);

  await setSystemConfig(TOKEN_KEY, response.token);
  await setSystemConfig(TOKEN_EXPIRY_KEY, expiresAt.toISOString());

  logger.info(
    { expiresAt: expiresAt.toISOString() },
    "Shiprocket: new token cached in SystemConfig"
  );

  return response.token;
}

/**
 * Returns a valid Shiprocket auth token.
 *
 * Reads TOKEN_KEY and TOKEN_EXPIRY_KEY from SystemConfig. If either is missing,
 * or the expiry is within TOKEN_REFRESH_MARGIN_MS of now (or past), triggers a
 * fresh login via loginAndCacheToken.
 *
 * Called at the top of every shiprocketFetch call (unless skipAuth is set).
 */
async function getAuthToken(): Promise<string> {
  const [cachedToken, cachedExpiry] = await Promise.all([
    getSystemConfig(TOKEN_KEY),
    getSystemConfig(TOKEN_EXPIRY_KEY),
  ]);

  if (!cachedToken || !cachedExpiry) {
    return loginAndCacheToken();
  }

  const expiryMs = new Date(cachedExpiry).getTime();
  if (!Number.isFinite(expiryMs)) {
    logger.warn(
      { cachedExpiry },
      "Shiprocket: cached expiry unparseable — forcing refresh"
    );
    return loginAndCacheToken();
  }

  const refreshAtMs = expiryMs - TOKEN_REFRESH_MARGIN_MS;
  if (Date.now() >= refreshAtMs) {
    logger.info(
      { expiryMs, refreshAtMs },
      "Shiprocket: token near expiry — refreshing"
    );
    return loginAndCacheToken();
  }

  return cachedToken;
}

// ============================================================
// PUBLIC API — CREATE ORDER
// ============================================================

/**
 * Raw response shape from POST /orders/create/adhoc.
 * `awb_code`, `courier_company_id`, `courier_name` are always null at this
 * stage — they're populated by a separate call to /courier/assign/awb.
 */
type CreateOrderRawResponse = {
  order_id?: number;
  shipment_id?: number;
  status?: string;
  status_code?: number;
  onboarding_completed_now?: number;
  awb_code?: string | null;
  courier_company_id?: number | null;
  courier_name?: string | null;
};

/**
 * Public params for createOrder. Caller supplies domain-level info; this
 * function assembles the full ~40-field Shiprocket payload and sends it.
 *
 * Fields we hardcode / omit:
 *   - pickup_location: from config.shiprocket.pickupLocationName
 *   - shipping_is_billing: true (we do not support split billing/shipping)
 *   - channel_id: omitted → Shiprocket assigns to the default "Custom" channel
 *   - comment / reseller_name / company_name: omitted for launch
 *
 * Currency assumption: all monetary fields are INR integers. If we ever route
 * international orders through this function, sub_total and selling_price need
 * currency conversion at the caller before it reaches here.
 */
export type CreateOrderParams = {
  /**
   * Our internal Order.id. Used verbatim as Shiprocket's `order_id`. Must be
   * unique per Shiprocket order and stable across retries — Shiprocket 422s
   * on duplicates and blocks reuse of cancelled-order IDs, so the worker
   * MUST check `Order.shiprocketOrderId` before retrying this call.
   */
  ourOrderId: string;

  /** Defaults to now if omitted. */
  orderDate?: Date;

  billing: {
    firstName: string;
    lastName?: string;
    address1: string;
    address2?: string;
    city: string;
    /** Digits only, positive integer as string. */
    pincode: string;
    state: string;
    country: string;
    email: string;
    /** Digits only. Any "+91"/spaces/hyphens must be stripped by caller. */
    phone: string;
  };

  item: {
    /**
     * Product name — shows on the shipping label. Built by the service as
     * `[Child Name]_[HARDCOVER|SOFTCOVER]_[Book Title]`.
     */
    name: string;
    /** Stable identifier; comicId is fine. */
    sku: string;
    units: number;
    /** Per-unit selling price in INR. Rounded to integer for Shiprocket. */
    sellingPrice: number;
    /** HSN code. 4901 for printed books. Optional for domestic. */
    hsn?: number;
  };

  paymentMethod: "Prepaid" | "COD";

  /**
   * Order subtotal in INR after discounts, rounded to integer. Shiprocket
   * does NOT compute this from line items — passing a wrong value causes
   * pricing mismatches. Caller is responsible for correctness.
   */
  subTotal: number;

  dimensions: {
    /** cm, must be > 0.5 */
    length: number;
    /** cm, must be > 0.5 */
    breadth: number;
    /** cm, must be > 0.5 */
    height: number;
    /** kg, must be > 0 */
    weight: number;
  };
};

export type CreateOrderResult = {
  /** Shiprocket's own numeric order id, stringified for Order.shiprocketOrderId. */
  shiprocketOrderId: string;
  /** Shiprocket's numeric shipment id, stringified for Order.shiprocketShipmentId. */
  shipmentId: string;
  /** Human status string, e.g. "NEW". Not persisted — kept for logs. */
  status: string;
};

/**
 * Formats a Date as "yyyy-mm-dd HH:MM" in local time — the format Shiprocket
 * expects for `order_date` on /orders/create/adhoc.
 */
function formatShiprocketDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/**
 * Parse a phone or pincode string to a positive integer. Throws ValidationError
 * on non-digit input so we fail with a clear field name rather than letting
 * Shiprocket 422 the whole order with a vague "Invalid Data".
 */
function toPositiveIntField(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(
      `Shiprocket createOrder: '${field}' must be a positive integer string, got "${value}"`
    );
  }
  return parsed;
}

/**
 * Builds the shared payload used by both /orders/create/adhoc and
 * /orders/update/adhoc. Both endpoints accept the same shape; keeping this
 * as one helper prevents the two calls from silently drifting (e.g. adding
 * a field to create but forgetting update).
 */
function buildAdhocOrderPayload(params: CreateOrderParams) {
  const orderDate = formatShiprocketDate(params.orderDate ?? new Date());

  return {
    order_id: params.ourOrderId,
    order_date: orderDate,
    pickup_location: config.shiprocket.pickupLocationName,

    billing_customer_name: params.billing.firstName,
    billing_last_name: params.billing.lastName ?? "",
    billing_address: params.billing.address1,
    billing_address_2: params.billing.address2 ?? "",
    billing_city: params.billing.city,
    billing_pincode: toPositiveIntField(
      params.billing.pincode,
      "billing.pincode"
    ),
    billing_state: params.billing.state,
    billing_country: params.billing.country,
    billing_email: params.billing.email,
    billing_phone: toPositiveIntField(params.billing.phone, "billing.phone"),

    shipping_is_billing: true,

    order_items: [
      {
        name: params.item.name,
        sku: params.item.sku,
        units: params.item.units,
        selling_price: Math.round(params.item.sellingPrice),
        ...(params.item.hsn !== undefined ? { hsn: params.item.hsn } : {}),
      },
    ],

    payment_method: params.paymentMethod,
    sub_total: Math.round(params.subTotal),

    length: params.dimensions.length,
    breadth: params.dimensions.breadth,
    height: params.dimensions.height,
    weight: params.dimensions.weight,
  };
}

/**
 * Creates a Shiprocket order via POST /orders/create/adhoc.
 *
 * On success the shipment exists in Shiprocket with a shipment_id but no AWB;
 * AWB assignment is a separate call (see assignAwb). If final packaging
 * dimensions differ from what was sent here, call updateOrder first.
 *
 * Idempotency: Shiprocket 422s on duplicate `order_id`. Since we use our
 * Order.id as `order_id`, retrying this call for the same Order fails at
 * Shiprocket. The worker must check `Order.shiprocketOrderId` before retrying.
 */
export async function createOrder(
  params: CreateOrderParams
): Promise<CreateOrderResult> {

  const payload = buildAdhocOrderPayload(params);

  logger.info(
    {
      ourOrderId: params.ourOrderId,
      subTotal: payload.sub_total,
      pickup: payload.pickup_location,
    },
    "Shiprocket: creating adhoc order"
  );

  const raw = (await shiprocketFetch("/orders/create/adhoc", {
    method: "POST",
    body: payload,
    errorCode: "SHIPROCKET_CREATE_ORDER_FAILED",
  })) as CreateOrderRawResponse;

  if (
    typeof raw.order_id !== "number" ||
    typeof raw.shipment_id !== "number" ||
    typeof raw.status !== "string"
  ) {
    logger.error({ raw }, "Shiprocket createOrder returned malformed response");
    throw new AppError(
      "Shiprocket createOrder returned malformed response",
      502,
      "SHIPROCKET_CREATE_ORDER_MALFORMED"
    );
  }

  logger.info(
    {
      ourOrderId: params.ourOrderId,
      shiprocketOrderId: raw.order_id,
      shipmentId: raw.shipment_id,
      status: raw.status,
    },
    "Shiprocket: adhoc order created"
  );

  return {
    shiprocketOrderId: String(raw.order_id),
    shipmentId: String(raw.shipment_id),
    status: raw.status,
  };
}

// ============================================================
// PUBLIC API — UPDATE ORDER
// ============================================================

/**
 * Raw response from POST /orders/update/adhoc.
 *
 * Notable Shiprocket quirks:
 *   - `partially_update: true` is NOT a warning — it's expected. Shiprocket
 *     only mutates order_items and dimensions on this endpoint, ignoring
 *     billing/shipping/etc. even when re-sent. Their response returns
 *     `not_updated_fields` listing what was skipped.
 *   - `awb_code`, `courier_company_id`, `courier_name` come back as empty
 *     strings (not null like on /create/adhoc). We ignore them here — they
 *     belong to /courier/assign/awb.
 */
type UpdateOrderRawResponse = {
  success?: boolean;
  partially_update?: boolean;
  not_updated_fields?: string;
  order_id?: number;
  shipment_id?: number;
  new_order_status?: string;
  old_order_status?: number;
  awb_code?: string;
  courier_company_id?: string;
  courier_name?: string;
};

/**
 * Same shape as CreateOrderParams — Shiprocket's update endpoint accepts the
 * full order payload and silently ignores fields it won't mutate. We reuse
 * the create params so the worker can build the payload identically for both
 * calls (Stage 1 create → Stage 2 update with real dimensions).
 */
export type UpdateOrderParams = CreateOrderParams;

export type UpdateOrderResult = {
  shiprocketOrderId: string;
  shipmentId: string;
  /**
   * Comma-separated field list Shiprocket refused to update. Always non-empty
   * on this endpoint — the update API is designed to only mutate items and
   * dimensions. Logged for audit, no action required.
   */
  notUpdatedFields: string;
};

/**
 * Updates an existing Shiprocket order via POST /orders/update/adhoc.
 *
 * Primary use: pushing real packaging dimensions after admin confirms them,
 * BEFORE the AWB is assigned (Shiprocket rejects updates after AWB). The
 * worker owns the "before AWB" invariant — this function does not enforce it.
 *
 * The full CreateOrderParams payload is sent because Shiprocket rejects
 * partial payloads with 422. Fields other than dimensions and items are
 * silently ignored server-side, which is why the response's `not_updated_fields`
 * always lists most of the payload.
 *
 * Idempotency: safe to retry. Re-sending the same dimensions produces the
 * same result. Shiprocket does not reject repeated updates.
 */
export async function updateOrder(
  params: UpdateOrderParams
): Promise<UpdateOrderResult> {
  const payload = buildAdhocOrderPayload(params);

  logger.info(
    {
      ourOrderId: params.ourOrderId,
      length: payload.length,
      breadth: payload.breadth,
      height: payload.height,
      weight: payload.weight,
    },
    "Shiprocket: updating adhoc order (dimensions refresh)"
  );

  const raw = (await shiprocketFetch("/orders/update/adhoc", {
    method: "POST",
    body: payload,
    errorCode: "SHIPROCKET_UPDATE_ORDER_FAILED",
  })) as UpdateOrderRawResponse;

  if (
    raw.success !== true ||
    typeof raw.order_id !== "number" ||
    typeof raw.shipment_id !== "number"
  ) {
    logger.error(
      { raw },
      "Shiprocket updateOrder returned malformed or unsuccessful response"
    );
    throw new AppError(
      "Shiprocket updateOrder returned malformed or unsuccessful response",
      502,
      "SHIPROCKET_UPDATE_ORDER_MALFORMED"
    );
  }

  logger.info(
    {
      ourOrderId: params.ourOrderId,
      shiprocketOrderId: raw.order_id,
      shipmentId: raw.shipment_id,
      newStatus: raw.new_order_status,
      notUpdatedFields: raw.not_updated_fields,
    },
    "Shiprocket: order updated"
  );

  return {
    shiprocketOrderId: String(raw.order_id),
    shipmentId: String(raw.shipment_id),
    notUpdatedFields: raw.not_updated_fields ?? "",
  };
}

// ============================================================
// PUBLIC API — ASSIGN AWB
// ============================================================

/**
 * Raw response from POST /courier/assign/awb.
 *
 * The interesting fields sit under `response.data`. Shiprocket returns a LOT
 * of shipper info here that we ignore (rto address, lat/long, etc.) — we only
 * type what we actually consume.
 *
 * `assigned_date_time.date` is a Shiprocket-local datetime string, not ISO —
 * we parse it with a fallback to Date.now() so a malformed string never
 * blocks AWB assignment on our side.
 */
type AssignAwbRawResponse = {
  awb_assign_status?: number;
  response?: {
    data?: {
      courier_company_id?: number;
      awb_code?: string;
      shipment_id?: number;
      order_id?: number;
      courier_name?: string;
      applied_weight?: number;
      assigned_date_time?: {
        date?: string;
        timezone_type?: number;
        timezone?: string;
      };
      pickup_scheduled_date?: string;
    };
  };
  // Shiprocket sometimes returns an error at the top level even with 200 OK
  message?: string;
  status_code?: number;
};

export type AssignAwbParams = {
  /** Shiprocket's shipment_id, from createOrder. */
  shipmentId: string;

  /**
   * Optional courier_id to force a specific courier. Omit to let Shiprocket
   * auto-assign the cheapest/fastest based on serviceability. For launch we
   * pass this from an admin choice if the admin picks a courier; otherwise
   * omit and let Shiprocket decide.
   */
  courierId?: number;

  /**
   * Set to "reassign" to swap the courier on an already-AWB'd shipment.
   * Shiprocket allows this only once per 24 hours per shipment. Not used by
   * the normal worker path — reserved for the admin "change courier"
   * endpoint (Section 7).
   */
  status?: "reassign";
};

export type AssignAwbResult = {
  awbCode: string;
  courierId: number;
  courierName: string;
  /** Kg, as computed by Shiprocket after AWB assignment. */
  appliedWeight: number;
  /**
   * When AWB was assigned. Best-effort parse from Shiprocket's non-ISO
   * datetime; falls back to current time if their string is malformed.
   */
  awbGeneratedAt: Date;
  /**
   * When the courier is scheduled to pick up. Parsed from Shiprocket's
   * "yyyy-MM-dd HH:mm:ss" string; null if missing or unparseable.
   */
  pickupScheduledDate: Date | null;
};

/**
 * Parses Shiprocket's non-ISO datetime strings ("yyyy-MM-dd HH:mm:ss[.SSS]")
 * into a Date. Returns null on malformed input rather than a NaN Date.
 *
 * Shiprocket sends these as Asia/Kolkata local time WITHOUT any offset marker.
 * We interpret them as UTC to avoid the server's local timezone leaking in,
 * which means the resulting Date is off by 5h30m from what the label shows.
 * That's fine for our use — we compare/store these timestamps, we don't
 * display them back to users. If UI ever surfaces them, format as IST.
 */
function parseShiprocketDate(s: string | undefined | null): Date | null {
  if (!s || typeof s !== "string") return null;
  // Turn "2022-11-25 14:00:00" into "2022-11-25T14:00:00Z" for Date parsing.
  const iso = s.replace(" ", "T").replace(/\.\d+$/, "") + "Z";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Assigns an AWB to an existing Shiprocket shipment via
 * POST /courier/assign/awb.
 *
 * Preconditions the caller (worker) owns:
 *   - Shiprocket order already exists (createOrder ran)
 *   - Final dimensions already pushed (updateOrder ran, if needed)
 *
 * On success, the shipment has an AWB and courier assigned. Next step is
 * generatePickup to actually schedule the courier collection.
 *
 * Idempotency: NOT idempotent without `status: "reassign"`. Calling twice on
 * the same shipment either returns the existing AWB (best case) or errors
 * with "Cannot reassign courier for this shipment." Worker MUST check
 * `Order.awbNumber` before calling.
 */
export async function assignAwb(
  params: AssignAwbParams
): Promise<AssignAwbResult> {
  const payload: Record<string, string | number> = {
    shipment_id: params.shipmentId,
  };
  if (params.courierId !== undefined) payload.courier_id = params.courierId;
  if (params.status !== undefined) payload.status = params.status;

  logger.info(
    {
      shipmentId: params.shipmentId,
      courierId: params.courierId,
      reassign: params.status === "reassign",
    },
    "Shiprocket: assigning AWB"
  );

  const raw = (await shiprocketFetch("/courier/assign/awb", {
    method: "POST",
    body: payload,
    errorCode: "SHIPROCKET_ASSIGN_AWB_FAILED",
  })) as AssignAwbRawResponse;

  // Shiprocket can return 200 OK with a top-level error message and no data.
  // Guard both cases: awb_assign_status !== 1, OR no data block.
  if (raw.awb_assign_status !== 1 || !raw.response?.data) {
    logger.error(
      { raw },
      "Shiprocket assignAwb reported failure or returned no data block"
    );
    throw new AppError(
      raw.message ??
        "Shiprocket assignAwb reported failure or returned no data block",
      502,
      "SHIPROCKET_ASSIGN_AWB_REJECTED"
    );
  }

  const data = raw.response.data;

  if (
    typeof data.awb_code !== "string" ||
    data.awb_code.length === 0 ||
    typeof data.courier_company_id !== "number" ||
    typeof data.courier_name !== "string"
  ) {
    logger.error(
      { data },
      "Shiprocket assignAwb returned malformed data block"
    );
    throw new AppError(
      "Shiprocket assignAwb returned malformed data block",
      502,
      "SHIPROCKET_ASSIGN_AWB_MALFORMED"
    );
  }

  const awbGeneratedAt =
    parseShiprocketDate(data.assigned_date_time?.date) ?? new Date();
  const pickupScheduledDate = parseShiprocketDate(data.pickup_scheduled_date);

  logger.info(
    {
      shipmentId: params.shipmentId,
      awbCode: data.awb_code,
      courierName: data.courier_name,
      courierId: data.courier_company_id,
      appliedWeight: data.applied_weight,
      pickupScheduledDate: pickupScheduledDate?.toISOString() ?? null,
    },
    "Shiprocket: AWB assigned"
  );

  return {
    awbCode: data.awb_code,
    courierId: data.courier_company_id,
    courierName: data.courier_name,
    appliedWeight: data.applied_weight ?? 0,
    awbGeneratedAt,
    pickupScheduledDate,
  };
}

// ============================================================
// PUBLIC API — GENERATE PICKUP
// ============================================================

/**
 * Raw response from POST /courier/generate/pickup.
 *
 * `others` is a stringified JSON blob of internal Shiprocket telemetry
 * (routing codes, ETD zones, recommendation data). We deliberately do not
 * parse or expose it — it's not part of Shiprocket's public contract and
 * has changed shape between accounts. Callers get what they actually need.
 */
type GeneratePickupRawResponse = {
  pickup_status?: number;
  response?: {
    pickup_scheduled_date?: string;
    pickup_token_number?: string;
    status?: number;
    pickup_generated_date?: {
      date?: string;
      timezone_type?: number;
      timezone?: string;
    };
    data?: string;
  };
  // Shiprocket also returns error messages at the top level on some failures.
  message?: string;
  status_code?: number;
};

export type GeneratePickupParams = {
  /**
   * Single Shiprocket shipment_id to schedule pickup for. Docs allow only one
   * per call; we wrap it into an array before sending. Passing our own
   * String type (matches assignAwb / createOrder returns).
   */
  shipmentId: string;

  /**
   * Optional future date for pickup, YYYY-MM-DD. Omit to let Shiprocket
   * schedule the earliest available slot (usually next working day). If the
   * date falls on a Sunday/holiday, Shiprocket auto-rolls to the next
   * available day per docs.
   */
  pickupDate?: string;

  /**
   * Set to "retry" to retry a previously-failed pickup request for the same
   * shipment. Normal path leaves this undefined.
   */
  status?: "retry";
};

export type GeneratePickupResult = {
  /** When the courier is scheduled to arrive. Null if Shiprocket returned an unparseable string. */
  pickupScheduledDate: Date | null;
  /** When Shiprocket generated the pickup request itself. Fallback: now(). */
  pickupGeneratedAt: Date;
  /**
   * Human-readable reference number Shiprocket assigns to the pickup.
   * Shown on manifests and useful for support escalation.
   */
  pickupTokenNumber: string;
  /**
   * Free-text confirmation message from Shiprocket, e.g.
   * "Pickup is confirmed by Xpressbees 1kg For AWB :- 143254213727423".
   * Logged for audit, not surfaced to end users.
   */
  confirmationMessage: string;
};

/**
 * Requests a courier pickup for a shipment via POST /courier/generate/pickup.
 *
 * Preconditions the caller (worker) owns:
 *   - Shiprocket order exists
 *   - AWB is already assigned (Shiprocket rejects otherwise)
 *
 * After success, the courier is scheduled to visit our registered pickup
 * address on `pickupScheduledDate`. Next step is generateManifest for the
 * handover document.
 *
 * Idempotency: NOT idempotent. Calling twice for the same shipment_id can
 * either silently succeed or error depending on Shiprocket's internal state.
 * Worker MUST check `Order.pickupGeneratedAt` before calling.
 */
export async function generatePickup(
  params: GeneratePickupParams
): Promise<GeneratePickupResult> {
  const payload: Record<string, unknown> = {
    // Docs example wraps the id in an array even for a single shipment.
    shipment_id: [params.shipmentId],
  };
  if (params.pickupDate !== undefined) {
    payload.pickup_date = [params.pickupDate];
  }
  if (params.status !== undefined) {
    payload.status = params.status;
  }

  logger.info(
    {
      shipmentId: params.shipmentId,
      pickupDate: params.pickupDate,
      retry: params.status === "retry",
    },
    "Shiprocket: generating pickup"
  );

  const raw = (await shiprocketFetch("/courier/generate/pickup", {
    method: "POST",
    body: payload,
    errorCode: "SHIPROCKET_GENERATE_PICKUP_FAILED",
  })) as GeneratePickupRawResponse;

  if (raw.pickup_status !== 1 || !raw.response) {
    logger.error(
      { raw },
      "Shiprocket generatePickup reported failure or returned no response"
    );
    throw new AppError(
      raw.message ??
        "Shiprocket generatePickup reported failure or returned no response",
      502,
      "SHIPROCKET_GENERATE_PICKUP_REJECTED"
    );
  }

  const r = raw.response;

  const pickupScheduledDate = parseShiprocketDate(r.pickup_scheduled_date);
  const pickupGeneratedAt =
    parseShiprocketDate(r.pickup_generated_date?.date) ?? new Date();

  logger.info(
    {
      shipmentId: params.shipmentId,
      pickupScheduledDate: pickupScheduledDate?.toISOString() ?? null,
      pickupGeneratedAt: pickupGeneratedAt.toISOString(),
      tokenNumber: r.pickup_token_number,
    },
    "Shiprocket: pickup generated"
  );

  return {
    pickupScheduledDate,
    pickupGeneratedAt,
    pickupTokenNumber: r.pickup_token_number ?? "",
    confirmationMessage: r.data ?? "",
  };
}

// ============================================================
// PUBLIC API — GENERATE LABEL
// ============================================================

/**
 * Raw response from POST /courier/generate/label.
 *
 * Two failure shapes to handle:
 *   1. HTTP 4xx with { message, errors } — caught by shiprocketFetch.
 *   2. HTTP 200 with `label_created: 0` and a `response` message — Shiprocket
 *      "succeeded" at the transport layer but refused to make the label.
 *      Usually means the shipment_id doesn't exist or has no AWB yet.
 */
type GenerateLabelRawResponse = {
  label_created?: number;
  label_url?: string;
  response?: string;
  not_created?: unknown[];
};

export type GenerateLabelParams = {
  /**
   * One or more Shiprocket shipment_ids to include on the label PDF. Passing
   * multiple ids returns a single PDF with all labels — useful when the admin
   * wants to print a whole batch at once. Single-id is the normal case.
   */
  shipmentIds: string[];
};

export type GenerateLabelResult = {
  /**
   * Fresh label PDF URL. Shiprocket caches this after first generation, so
   * repeated calls for the same shipment return the same URL — but we do not
   * store it on our side (see DECISIONS: label URLs are fetched fresh every
   * time to avoid stale-link risk if Shiprocket rotates storage).
   */
  labelUrl: string;
  /** Free-text confirmation, e.g. "Label has been created and uploaded successfully!" */
  message: string;
};

/**
 * Generates a shipping label PDF via POST /courier/generate/label.
 *
 * Preconditions the caller owns:
 *   - Each shipment already has an AWB assigned (Shiprocket refuses otherwise)
 *
 * The returned URL is an S3 link and opens directly in a browser tab. The
 * admin panel opens it in a new window for printing.
 *
 * Idempotency: safe. Shiprocket returns the same cached URL on repeat calls.
 */
export async function generateLabel(
  params: GenerateLabelParams
): Promise<GenerateLabelResult> {
  if (params.shipmentIds.length === 0) {
    throw new ValidationError(
      "Shiprocket generateLabel: shipmentIds must contain at least one id"
    );
  }

  logger.info(
    { shipmentIds: params.shipmentIds, count: params.shipmentIds.length },
    "Shiprocket: generating label"
  );

  const raw = (await shiprocketFetch("/courier/generate/label", {
    method: "POST",
    body: { shipment_id: params.shipmentIds },
    errorCode: "SHIPROCKET_GENERATE_LABEL_FAILED",
  })) as GenerateLabelRawResponse;

  // Shiprocket's soft-fail path: HTTP 200 but label_created: 0.
  if (raw.label_created !== 1 || !raw.label_url) {
    logger.error(
      { raw, shipmentIds: params.shipmentIds },
      "Shiprocket generateLabel returned no label URL"
    );
    throw new AppError(
      raw.response ??
        "Shiprocket generateLabel returned no label URL — shipments likely missing AWB",
      502,
      "SHIPROCKET_GENERATE_LABEL_REJECTED"
    );
  }

  logger.info(
    { shipmentIds: params.shipmentIds, labelUrl: raw.label_url },
    "Shiprocket: label generated"
  );

  return {
    labelUrl: raw.label_url,
    message: raw.response ?? "",
  };
}

// ============================================================
// PUBLIC API — GENERATE MANIFEST
// ============================================================

/**
 * Raw response from POST /manifests/generate.
 *
 * Three response shapes to handle:
 *   1. Success: { status: 1, manifest_url: "https://..." }
 *   2. Empty-URL soft-fail: { status: 1, manifest_url: "" }
 *      — Shiprocket claims success but returned no URL. Treat as failure.
 *   3. Already-manifested rejection (HTTP 400):
 *      { message, status_code: 400, already_manifested_shipment_ids: [...] }
 *      — At least one shipment already has a manifest. Surfaced with a
 *      dedicated error code so callers can retry with the offending ids
 *      removed, or fall back to /manifests/print for the existing manifest.
 */
type GenerateManifestRawResponse = {
  status?: number;
  manifest_url?: string;
  // Present on the "already manifested" failure path.
  message?: string;
  status_code?: number;
  already_manifested_shipment_ids?: number[];
};

export type GenerateManifestParams = {
  /**
   * One or more Shiprocket shipment_ids to include on the manifest. Each
   * shipment must already have an AWB assigned AND a pickup request
   * generated — Shiprocket rejects the whole call otherwise.
   */
  shipmentIds: string[];
};

export type GenerateManifestResult = {
  /** Fresh manifest PDF URL. Opens directly in a browser. */
  manifestUrl: string;
};

/**
 * Generates a manifest PDF listing one or more shipments, via
 * POST /manifests/generate.
 *
 * Preconditions the caller owns:
 *   - Each shipment has an AWB assigned
 *   - Each shipment has an active pickup request
 *   - No shipment in the batch already has a manifest generated
 *     (Shiprocket 400s the entire call if any one does)
 *
 * The URL returned is not cached on our side — same policy as generateLabel.
 * We fetch fresh each time to avoid stale links if Shiprocket rotates storage.
 *
 * Idempotency: NOT safe to retry blindly. Second call on the same shipments
 * returns a 400 with `already_manifested_shipment_ids` listing every shipment
 * from the first successful call. Callers should either handle that error
 * (retry without those ids, or fall back to /manifests/print for the existing
 * manifest — added as a separate function below).
 */
export async function generateManifest(
  params: GenerateManifestParams
): Promise<GenerateManifestResult> {
  if (params.shipmentIds.length === 0) {
    throw new ValidationError(
      "Shiprocket generateManifest: shipmentIds must contain at least one id"
    );
  }

  logger.info(
    { shipmentIds: params.shipmentIds, count: params.shipmentIds.length },
    "Shiprocket: generating manifest"
  );

  let raw: GenerateManifestRawResponse;
  try {
    raw = (await shiprocketFetch("/manifests/generate", {
      method: "POST",
      body: { shipment_id: params.shipmentIds },
      errorCode: "SHIPROCKET_GENERATE_MANIFEST_FAILED",
    })) as GenerateManifestRawResponse;
  } catch (err) {
    // Shiprocket returns HTTP 400 with a structured body when at least one of
    // the shipments already has a manifest. shiprocketFetch throws AppError
    // with the response body embedded in the message. We check for the marker
    // and surface a specific error code so the caller can react (e.g. retry
    // without those ids, or call /manifests/print for the existing manifest).
    if (
      err instanceof AppError &&
      /already_manifested_shipment_ids/.test(err.message)
    ) {
      logger.warn(
        { shipmentIds: params.shipmentIds },
        "Shiprocket generateManifest: one or more shipments already manifested"
      );
      throw new AppError(
        err.message,
        409,
        "SHIPROCKET_MANIFEST_ALREADY_EXISTS"
      );
    }
    throw err;
  }

  if (raw.status !== 1 || !raw.manifest_url || raw.manifest_url.length === 0) {
    logger.error(
      { raw, shipmentIds: params.shipmentIds },
      "Shiprocket generateManifest returned no manifest URL"
    );
    throw new AppError(
      "Shiprocket generateManifest returned success but no manifest URL",
      502,
      "SHIPROCKET_GENERATE_MANIFEST_REJECTED"
    );
  }

  logger.info(
    { shipmentIds: params.shipmentIds, manifestUrl: raw.manifest_url },
    "Shiprocket: manifest generated"
  );

  return { manifestUrl: raw.manifest_url };
}

// ============================================================
// PUBLIC API — PRINT MANIFEST
// ============================================================

/**
 * Raw response from POST /manifests/print.
 *
 * Failure shapes:
 *   1. Empty URL: { manifest_url: "" } — Shiprocket returns 200 OK but
 *      couldn't find a generated manifest for the given order ids.
 *   2. HTTP 500: { message: "Invalid argument...", status_code: 500 }
 *      — Caught by shiprocketFetch as a transport failure.
 */
type PrintManifestRawResponse = {
  manifest_url?: string;
};

export type PrintManifestParams = {
  /**
   * Shiprocket order_ids (NOT shipment_ids) whose already-generated
   * manifest we want to fetch the URL of.
   *
   * IMPORTANT: this endpoint uses order_ids, unlike generateManifest which
   * uses shipment_ids. Shiprocket's order_id and shipment_id are two
   * separate identifiers returned by createOrder. Pass what we stored on
   * `Order.shiprocketOrderId`.
   */
  orderIds: string[];
};

export type PrintManifestResult = {
  /** Fresh manifest PDF URL. Same manifest as generateManifest returned. */
  manifestUrl: string;
};

/**
 * Fetches the URL of an already-generated manifest via POST /manifests/print.
 *
 * Use case: paired with generateManifest as a fallback path. If
 * generateManifest throws SHIPROCKET_MANIFEST_ALREADY_EXISTS (Shiprocket 409'd
 * because the manifest was already generated), the admin endpoint calls
 * printManifest with the same orders to get the existing manifest's URL back.
 *
 * Can also be used independently by an admin to re-fetch a manifest URL for
 * orders that were manifested earlier (e.g. yesterday's batch).
 *
 * Idempotency: fully idempotent. Fetches the same PDF URL on every call.
 */
export async function printManifest(
  params: PrintManifestParams
): Promise<PrintManifestResult> {
  if (params.orderIds.length === 0) {
    throw new ValidationError(
      "Shiprocket printManifest: orderIds must contain at least one id"
    );
  }

  logger.info(
    { orderIds: params.orderIds, count: params.orderIds.length },
    "Shiprocket: printing manifest"
  );

  const raw = (await shiprocketFetch("/manifests/print", {
    method: "POST",
    body: { order_ids: params.orderIds },
    errorCode: "SHIPROCKET_PRINT_MANIFEST_FAILED",
  })) as PrintManifestRawResponse;

  if (!raw.manifest_url || raw.manifest_url.length === 0) {
    logger.error(
      { raw, orderIds: params.orderIds },
      "Shiprocket printManifest returned no manifest URL"
    );
    throw new AppError(
      "Shiprocket printManifest returned no manifest URL — orders likely never manifested",
      502,
      "SHIPROCKET_PRINT_MANIFEST_REJECTED"
    );
  }

  logger.info(
    { orderIds: params.orderIds, manifestUrl: raw.manifest_url },
    "Shiprocket: manifest print URL fetched"
  );

  return { manifestUrl: raw.manifest_url };
}

// ============================================================
// PUBLIC API — TRACK BY AWB
// ============================================================

/**
 * Raw response from GET /courier/track/awb/{awb_code}.
 *
 * Two success shapes to handle:
 *   1. Full data: track_status: 1 with shipment_track, activities, etc.
 *   2. No-data-yet: track_status: 0 with an error message — happens right
 *      after AWB assignment before the courier has scanned anything. NOT a
 *      permanent failure; we surface it as a soft "pending" state so callers
 *      can distinguish "not tracked yet" from "actually broken".
 *
 * 404s are caught by shiprocketFetch and thrown as SHIPROCKET_TRACK_FAILED.
 */
type TrackByAwbActivity = {
  date?: string;
  status?: string;
  activity?: string;
  location?: string;
  "sr-status"?: string;
  "sr-status-label"?: string;
};

type TrackByAwbShipmentTrackEntry = {
  awb_code?: string;
  courier_company_id?: number;
  shipment_id?: number;
  order_id?: number;
  pickup_date?: string;
  delivered_date?: string;
  weight?: string;
  packages?: number;
  current_status?: string;
  delivered_to?: string;
  destination?: string;
  origin?: string;
  courier_name?: string;
  edd?: string | null;
  pod?: string;
  pod_status?: string;
};

type TrackByAwbRawResponse = {
  tracking_data?: {
    track_status?: number;
    shipment_status?: number;
    shipment_track?: TrackByAwbShipmentTrackEntry[];
    shipment_track_activities?: TrackByAwbActivity[];
    track_url?: string;
    etd?: string | null;
    error?: string;
    qc_response?: {
      qc_image?: string;
      qc_failed_reason?: string;
    };
  };
};

export type TrackByAwbParams = {
  awbCode: string;
};

/**
 * Single scan event from the courier's journey. Ordered newest-first in
 * `activities`, same order Shiprocket returns them.
 */
export type TrackActivity = {
  /** Parsed timestamp of this scan. Null if Shiprocket sent an unparseable date. */
  date: Date | null;
  /** Short courier code, e.g. "DLVD", "OFD", "IT". */
  courierStatus: string;
  /** Free-text description from the courier, e.g. "Out for Delivery". */
  activity: string;
  /** Where the scan happened, e.g. "BANGALORE, KARNATAKA". */
  location: string;
  /** Shiprocket's normalised status label, e.g. "DELIVERED", "IN TRANSIT". */
  shiprocketStatusLabel: string;
};

export type TrackByAwbResult = {
  /**
   * "pending" when Shiprocket returned track_status: 0 (no scans yet — normal
   * right after AWB assignment). "tracked" when full data was returned.
   * Callers should treat "pending" as a soft state, not an error.
   */
  state: "pending" | "tracked";
  /** Human-readable current status, e.g. "Delivered", "In Transit". Empty for "pending". */
  currentStatus: string;
  /** Courier name from Shiprocket. Empty for "pending". */
  courierName: string;
  /** Public tracking URL customers can view. Empty for "pending". */
  trackUrl: string;
  /** Estimated delivery. Null when Shiprocket returned no ETD or "pending". */
  estimatedDelivery: Date | null;
  /** Full activity history, newest-first. Empty array for "pending". */
  activities: TrackActivity[];
  /** Pickup timestamp from the shipment_track block. Null if missing/pending. */
  pickupDate: Date | null;
  /** Delivery timestamp from the shipment_track block. Null unless delivered. */
  deliveredDate: Date | null;
};

/**
 * Fetches current tracking status for a shipment via
 * GET /courier/track/awb/{awb_code}.
 *
 * Called only as a fallback path — the primary tracking mechanism is the
 * Shiprocket webhook (Section 5), which pushes status updates as they happen.
 * This function exists for three specific cases:
 *   1. Webhook was missed/delayed; admin or cron refreshes on demand
 *   2. Admin clicks "Refresh Tracking" on an order page
 *   3. Live-fetch for a customer-facing tracking page (future)
 *
 * Idempotency: fully idempotent (read-only GET). Safe to retry / call
 * repeatedly.
 */
export async function trackByAwb(
  params: TrackByAwbParams
): Promise<TrackByAwbResult> {
  if (!params.awbCode || params.awbCode.trim().length === 0) {
    throw new ValidationError(
      "Shiprocket trackByAwb: awbCode must be a non-empty string"
    );
  }

  logger.info({ awbCode: params.awbCode }, "Shiprocket: fetching tracking");

  const raw = (await shiprocketFetch(
    `/courier/track/awb/${encodeURIComponent(params.awbCode)}`,
    {
      method: "GET",
      errorCode: "SHIPROCKET_TRACK_FAILED",
    }
  )) as TrackByAwbRawResponse;

  const td = raw.tracking_data;
  if (!td) {
    logger.error(
      { raw, awbCode: params.awbCode },
      "Shiprocket trackByAwb returned no tracking_data block"
    );
    throw new AppError(
      "Shiprocket trackByAwb returned no tracking_data block",
      502,
      "SHIPROCKET_TRACK_MALFORMED"
    );
  }

  // Pending path: no scans in Shiprocket's system yet. Normal right after
  // AWB assignment. Not an error.
  if (td.track_status === 0) {
    logger.info(
      { awbCode: params.awbCode, message: td.error },
      "Shiprocket: tracking not yet available"
    );
    return {
      state: "pending",
      currentStatus: "",
      courierName: "",
      trackUrl: "",
      estimatedDelivery: null,
      activities: [],
      pickupDate: null,
      deliveredDate: null,
    };
  }

  const firstTrack = td.shipment_track?.[0] ?? {};

  const activities: TrackActivity[] = (td.shipment_track_activities ?? []).map(
    (a) => ({
      date: parseShiprocketDate(a.date),
      courierStatus: a.status ?? "",
      activity: a.activity ?? "",
      location: a.location ?? "",
      shiprocketStatusLabel: a["sr-status-label"] ?? "",
    })
  );

  const result: TrackByAwbResult = {
    state: "tracked",
    currentStatus: firstTrack.current_status ?? "",
    courierName: firstTrack.courier_name ?? "",
    trackUrl: td.track_url ?? "",
    estimatedDelivery: parseShiprocketDate(td.etd ?? null),
    activities,
    pickupDate: parseShiprocketDate(firstTrack.pickup_date),
    deliveredDate: parseShiprocketDate(firstTrack.delivered_date),
  };

  logger.info(
    {
      awbCode: params.awbCode,
      currentStatus: result.currentStatus,
      activityCount: activities.length,
    },
    "Shiprocket: tracking fetched"
  );

  return result;
}


// ============================================================
// PUBLIC API — CANCEL ORDER
// ============================================================

export type CancelOrderParams = {
  /**
   * Shiprocket order_ids (NOT shipment_ids) to cancel. Pass what we stored
   * on `Order.shiprocketOrderId`. Multiple ids can be cancelled in one call —
   * useful for admin bulk-cancel actions if they ever exist.
   */
  shiprocketOrderIds: string[];
};

export type CancelOrderResult = {
  /** How many ids were submitted for cancellation. */
  cancelledCount: number;
};

/**
 * Cancels one or more Shiprocket orders via POST /orders/cancel.
 *
 * Shiprocket returns 204 No Content on success — no per-id status is
 * returned, so we cannot tell from the response which ids were actually
 * cancelled versus which were already cancelled or never existed. The API
 * effectively says "we accepted the request" and leaves reconciliation to
 * the caller. If per-id status becomes important, add a follow-up fetch of
 * each order's state via a separate endpoint.
 *
 * Use cases (admin-only, no user-facing cancel):
 *   - Wrong shipping address discovered after order creation
 *   - Print defect requiring reprint + reship
 *   - Duplicate order created accidentally
 *   - Customer refund request
 *   - Stale / abandoned READY_TO_SHIP orders
 *
 * Idempotency: safe to retry. Shiprocket does not error on cancelling
 * already-cancelled orders (based on 204 semantics — no body to indicate
 * either way).
 */
export async function cancelOrder(
  params: CancelOrderParams
): Promise<CancelOrderResult> {
  if (params.shiprocketOrderIds.length === 0) {
    throw new ValidationError(
      "Shiprocket cancelOrder: shiprocketOrderIds must contain at least one id"
    );
  }

  logger.info(
    {
      shiprocketOrderIds: params.shiprocketOrderIds,
      count: params.shiprocketOrderIds.length,
    },
    "Shiprocket: cancelling orders"
  );

  await shiprocketFetch("/orders/cancel", {
    method: "POST",
    body: { ids: params.shiprocketOrderIds },
    errorCode: "SHIPROCKET_CANCEL_ORDER_FAILED",
  });

  logger.info(
    { shiprocketOrderIds: params.shiprocketOrderIds },
    "Shiprocket: cancel request accepted"
  );

  return { cancelledCount: params.shiprocketOrderIds.length };
}