# UniLake Kids — Backend

API, real-time updates and background processing for **UniLake Kids**, a store
for personalised children's comic books. A parent picks a comic, enters their
child's name and uploads a photo; the child is face-swapped into the
illustrations by an AI pipeline. Free preview pages are generated first; after
payment the rest of the book is generated, the parent picks their favourite
version of each page, and the book is compiled to a print-ready PDF and shipped.

This service owns all of that: the catalogue and CMS, the order-session state
machine, the AI generation pipeline, payments, PDF compilation, shipping and
customer email.

> The storefront and admin panel live in the separate **frontend** repository
> (Next.js), which talks to this service over REST and WebSocket.

---

## Contents

- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Scripts and everyday commands](#scripts-and-everyday-commands)
- [Project structure](#project-structure)
- [Request lifecycle and conventions](#request-lifecycle-and-conventions)
- [API surface](#api-surface)
- [The order-session lifecycle](#the-order-session-lifecycle)
- [Background jobs](#background-jobs)
- [Data model](#data-model)
- [Engineering rules](#engineering-rules)
- [Database migrations](#database-migrations)
- [Working with webhooks locally](#working-with-webhooks-locally)
- [Quality checks](#quality-checks)
- [Troubleshooting](#troubleshooting)

---

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 22, TypeScript (ESM), run directly with `tsx` — there is no build step |
| HTTP | Express 5 |
| Validation | Zod 4 |
| Database | PostgreSQL on **Neon**, via Prisma 7 with the `@prisma/adapter-neon` driver |
| Auth | Better Auth — email/password, Google, Facebook; cookie sessions |
| Queues | BullMQ on Redis (`ioredis`) |
| Real-time | `ws` — a raw WebSocket server sharing the HTTP port |
| Object storage | Cloudflare R2 (S3 API, `@aws-sdk/client-s3`) — one public and one private bucket |
| AI generation | RunPod serverless endpoint running a ComfyUI face-swap workflow |
| Image/PDF | `sharp`, `opentype.js` (text rendering), `pdf-lib` |
| Payments | Razorpay |
| Shipping | Shiprocket |
| Email | Resend |
| Logging | Pino (`pino-pretty` in development) |

---

## Architecture

One Node process runs everything: the REST API, the WebSocket server, the
BullMQ workers and an hourly expiry sweeper.

```
                         ┌──────────────── this process ─────────────────┐
  Browser ──REST──────►  │  Express  /api/public  /api/user  /api/admin  │
  (frontend)             │           /api/auth (Better Auth)             │
          ◄──WebSocket── │  ws server (per-session rooms)                │
                         │                                               │
  Razorpay ──webhook──►  │  /api/webhooks/razorpay                       │
  Shiprocket ─webhook─►  │  /api/webhooks/shiprocket                     │
                         │                                               │
                         │  BullMQ workers: sd-generation, pdf, shiprocket│
                         │  Expiry sweeper (hourly)                      │
                         └──────┬───────────┬──────────┬─────────┬───────┘
                                │           │          │         │
                          PostgreSQL     Redis        R2      RunPod / Shiprocket /
                           (Neon)      (queues)   (files)     Razorpay / Resend
```

Key properties:

- **The API never does slow work inline.** Generating a page, compiling a PDF
  or creating a shipment is queued in Redis and picked up by a worker.
- **The browser learns about progress over WebSocket** (`page:ready`,
  `page:error`, `session:preview-ready`, `session:paid-ready`). The REST
  snapshot `GET /api/public/sessions/:id` is always the source of truth; socket
  events are a speed-up, never the only signal.
- **Files go directly between the browser and R2.** The API hands out
  short-lived presigned upload URLs; uploads never stream through Express.

---

## Getting started

### Prerequisites

- **Node.js 22** (the Docker image uses `node:22`).
- **A Neon database you own for development.** The runtime uses Neon's
  serverless driver, which only talks to Neon — a plain local Postgres will not
  work. Create a Neon **branch** for yourself. Never develop against the
  production database.
- **Redis** — locally (`docker run -p 6379:6379 redis:7`) or a managed instance.
- Credentials for R2, RunPod, Razorpay (test mode), Shiprocket, Resend, and
  Google/Facebook OAuth. Ask the team for development credentials.

### Setup

```bash
npm install                     # also applies patches/ via patch-package
cp .env.example .env            # then fill in every value
npx prisma generate             # generates the client into src/generated/prisma
npx prisma migrate deploy       # applies migrations to YOUR dev database
npm run dev                     # http://localhost:8080
```

`GET /health` should answer once the server is up.

Notes:

- **Every variable in `.env.example` is required.** `src/config/env.ts` exits
  with `FATAL ERROR: Missing required environment variable` if one is missing.
- **The Prisma client is not committed.** Re-run `npx prisma generate` after
  pulling a schema change, or the code will not type-check.
- **Prisma CLI commands use `DIRECT_URL`** (see `prisma.config.ts`); the app at
  runtime uses `DATABASE_URL`. Check both point at your dev database before
  running any migration command.
- **The frontend expects the API on port 8080** by default.

### Making an admin

Sign up through the frontend, then set your user's `role` to `ADMIN` directly in
your dev database (e.g. with `npx prisma studio`). After that, other users can
be promoted from the admin panel's Users page.

---

## Scripts and everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Start with file watching (`tsx watch src/server.ts`) |
| `npm start` | Start without watching — what the Docker image runs |
| `npx tsc --noEmit` | Type-check the whole project — **run before every commit** |
| `npx prisma generate` | Regenerate the Prisma client after a schema change |
| `npx prisma migrate dev --create-only --name <name>` | Create a migration without applying it (see [Database migrations](#database-migrations)) |
| `npx prisma migrate deploy` | Apply pending migrations |
| `npx prisma studio` | Browse your dev database |

---

## Project structure

```
backend/
├── prisma/
│   ├── schema.prisma          # the data model
│   └── migrations/            # SQL migrations, applied in order
├── patches/                   # patch-package fixes to dependencies (see below)
├── src/
│   ├── server.ts              # entry point: HTTP server + WebSocket + workers
│   ├── app.ts                 # Express app: CORS, helmet, route mounting
│   ├── config/
│   │   ├── env.ts             # env loading + validation — the only place env is read
│   │   ├── generation.ts      # generation limits and bubble/text defaults
│   │   ├── shipping.ts        # default package dimensions + admin input bounds
│   │   ├── stats.ts           # admin dashboard tunables (IST reporting, thresholds)
│   │   └── workflows/api-workflow.json   # the ComfyUI workflow sent to RunPod
│   ├── routes/                # admin.ts, public.ts, user.ts, webhooks.ts
│   ├── controllers/           # parse request → call service → send response
│   ├── services/              # all business logic, one file per domain
│   ├── validators/            # Zod schemas for bodies, params and queries
│   ├── middlewares/           # requireAdmin, requireLoggedIn, validateBody, errorHandler
│   ├── jobs/
│   │   ├── queues.ts          # BullMQ queue definitions + default retry policy
│   │   └── workers/           # generation, pdf, shiprocket workers
│   │       └── sd/            # generation internals: text stamping, RunPod client,
│   │                          #   workflow patching, photo cache
│   ├── websocket/             # ws server, per-session rooms, event emitters
│   ├── lib/                   # clients and infrastructure: prisma, redis, r2, auth,
│   │                          #   razorpay, shiprocket, email, logger, image
│   ├── utils/                 # errors, asyncHandler, response helper, status mapping
│   ├── types/                 # Express request augmentation (req.user, req.session)
│   └── generated/prisma/      # GENERATED Prisma client — git-ignored, never edit
└── Dockerfile
```

**Where does new code go?** A new feature is typically: a Zod schema in
`validators/`, a service function in `services/`, a thin handler in
`controllers/`, and one line in the matching `routes/` file.

---

## Request lifecycle and conventions

```
route  ──►  validateBody(schema)  ──►  controller  ──►  service  ──►  prisma / lib
                                         │
                       asyncHandler forwards any throw to errorHandler
```

- **Controllers are thin.** They validate params/query (body validation usually
  happens in `validateBody` on the route), call one service function, and send
  the result. Business rules live in services.
- **`validateBody` replaces `req.body` with Zod's parsed output**, so transforms
  (defaults, trimming, de-duplication) are what the controller receives.
- **Response envelope.** Success: `{ success: true, data, message? }` via
  `sendSuccess`. Error: `{ success: false, error: { code, message } }`. The
  frontend's HTTP client unwraps this envelope, so keep every JSON endpoint on it.
  (File downloads such as the customer CSV export are the deliberate exception.)
- **Errors.** Throw the classes in `utils/errors.ts` — `ValidationError` (400),
  `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404),
  `ConflictError` (409) — or `AppError` with a custom status. Their message is
  shown to the user. Any other error becomes a generic 500 in production, with
  the real message only in development.
- **Logging.** Use the Pino `logger`, with structured context first:
  `logger.error({ err, sessionId }, "message")`. Put errors under the **`err`**
  key — Pino only serialises an Error's message and stack under that key.
- **Money** is `Decimal` in the database and serialised as a **string**
  (`"1499.00"`). Requests send plain numbers.
- **IDs** are UUIDs, except Better Auth user IDs, which are random strings.
- **BigInt** (generation seeds) is serialised to JSON as a string (`app.ts`).
- **Comments explain why.** The codebase documents intent, invariants and past
  incidents next to the code they protect. Read them before changing a guard,
  and keep the same standard in new code.

---

## API surface

| Mount | Auth | Purpose |
|---|---|---|
| `/api/auth/*` | — | Better Auth (sign-in, sign-up, OAuth callbacks, session) |
| `/api/public/*` | none | Catalogue, CMS content, and the personalisation flow (sessions, photo upload, generation, checkout) |
| `/api/user/*` | logged in | The customer's addresses, orders, tracking, and send-to-print |
| `/api/admin/*` | `ADMIN` role | Comics, pages, speech bubbles, fonts, pricing, CMS, orders and shipping, users, customers, stats |
| `/api/webhooks/*` | signature / token | Razorpay and Shiprocket callbacks (raw body) |
| `/health` | none | Liveness |
| WebSocket `/?sessionId=…&token=…` | `wsRoomToken` | Live generation events for one session |

The route files (`src/routes/*.ts`) are the index — each route has a one-line
comment, and ordering notes where a literal path must come before a `:param`
path.

**Middleware order in `app.ts` matters:** Better Auth and the webhook router are
mounted **before** `express.json()`, because both need the raw request body
(webhook signature verification hashes the exact bytes received).

---

## The order-session lifecycle

`OrderSession` is one customer's in-progress book — it is *not* a login
session (that is Better Auth's `Session`). It is created anonymously when
someone starts personalising a comic, and it moves through:

```
CREATED ─► PHOTO_UPLOADED ─► GENERATING_PREVIEW ─► PREVIEW_READY ─► AWAITING_PAYMENT
                                                                            │ payment captured
                                                                            ▼ (Razorpay webhook)
COMPLETED ◄─ SHIPMENT_QUEUED ◄─ COMPILING_PDF ◄─ CONFIRMED ◄─ PAID_PAGES_READY ◄─ GENERATING_PAID ◄─ PAID
                  │                  │                  ▲ customer clicks
                  ▼                  ▼                  │ "Send to Print"
          SHIPMENT_FAILED       PDF_FAILED

   FAILED — every generated page failed, or the session expired before payment
```

What happens at each stage:

1. **Preview.** The customer enters details and uploads a photo (direct to the
   private R2 bucket). `POST …/generate` queues one job per **preview page**
   (`Page.isPreviewPage`). When all of them settle, the session becomes
   `PREVIEW_READY` and email 1 is sent.
2. **Checkout.** `POST …/checkout` (login required) creates a Razorpay order and
   an `Order` row holding a snapshot of the price and shipping address. The
   session becomes `AWAITING_PAYMENT`.
3. **Payment.** The Razorpay `payment.captured` webhook flips the order and
   session to `PAID`, queues every remaining page, and sends email 2. **The
   webhook — not the browser — is what confirms payment.**
4. **Selection.** When every paid page settles: `PAID_PAGES_READY`, email 3.
   The customer can regenerate pages (more variants allowed after payment) and
   picks one variant per page.
5. **Send to print.** `POST /api/user/sessions/:id/send-to-print` locks the
   selections (`CONFIRMED`), sends email 4 and queues PDF compilation.
6. **Fulfilment.** The PDF worker builds the PDF and queues the Shiprocket
   worker, which creates the shipment. An admin then enters the real package
   dimensions, which assigns the AWB and books pickup (email 5). Shiprocket
   webhooks keep tracking up to date; delivery sends email 6.

**Expiry.** Unpaid sessions live for **7 days** from creation
(`SESSION_LIFETIME_DAYS` in `session.service.ts` — the frontend keeps a copy of
this window, change both together). After that they are flipped to `FAILED` on
the next attempt to use them, and by the hourly sweeper. Sessions at
`AWAITING_PAYMENT` or later never expire. Expired sessions are marked, not
deleted.

### The generation pipeline (one job = one page version)

`jobs/workers/generationWorker.ts`, per `PageVersion`:

1. **Text stamping** — the page's speech bubbles are rendered onto the artwork
   with `opentype.js` and `sharp`, substituting `{name}` and pronoun tokens.
   Bubble geometry and font size are stored as **fractions of the artwork**,
   not pixels, so artwork can be re-uploaded at any resolution.
2. **Face swap** — only for pages with `hasFace`. The stamped page, the page's
   head mask and the child's photo are sent to RunPod with the ComfyUI workflow
   (`config/workflows/api-workflow.json`, patched per job in `sd/workflow.ts`),
   then polled until done.
3. **Upload** — the print-resolution PNG and a web-sized WebP are stored under
   `sessions/{sessionId}/final/` in the public bucket.
4. **Notify** — `page:ready` over WebSocket, then a check whether this was the
   last outstanding page (which flips the session status).

Retries: 3 attempts with exponential backoff. A page is only marked `FAILED`
after the final attempt.

### Customer email

All six transactional emails live in `services/notification.service.ts`
(shared layout + one template per milestone) and are sent through
`lib/email.ts`. Sending is fire-and-forget — **an email failure never blocks
or rolls back business logic.** Each email is sent exactly once because its
call site sits behind a status change that only one caller can win.

---

## Background jobs

| Queue | Worker | Concurrency | Job ID (dedupe key) |
|---|---|---|---|
| `sd-generation` | `generationWorker.ts` | 5 | `pageVersionId` |
| `pdf-compilation` | `pdfWorker.ts` | 5 | `orderSessionId` |
| `shiprocket` | `shiprocketWorker.ts` | 5 | `orderSessionId` |

- Default policy (`jobs/queues.ts`): 3 attempts, exponential backoff starting at
  2 s; completed jobs kept 24 h, failed jobs 7 days.
- **Job IDs are idempotency keys.** Adding a job whose ID already exists is a
  no-op in BullMQ — that is what stops a retried webhook from generating (and
  paying RunPod for) the same page twice.
- Generation jobs use **page number as priority**, so books progress side by
  side instead of one customer's whole book blocking the next.
- The **expiry sweeper** runs hourly from `jobs/workers/index.ts`.
- Workers shut down gracefully on `SIGTERM`/`SIGINT`, finishing in-flight jobs.

---

## Data model

Defined in `prisma/schema.prisma`. The main groups:

| Group | Models |
|---|---|
| Auth (owned by Better Auth) | `User` (+ `role`), `Session`, `Account`, `Verification` |
| Catalogue | `Comic` → `Page` → `Bubble`; `Font`; `Theme` (many-to-many with `Comic`); `ComicFact` |
| Pricing | `Country`, `PricingRule` (per comic × country × cover type) |
| Ordering | `OrderSession` → `PageVersion` (every generated variant); `Order`; `SavedAddress` |
| Integrations | `WebhookEvent` (webhook dedupe log), `SystemConfig` (e.g. cached Shiprocket token) |
| CMS | `AnnouncementBar`, `HeroImage`, `CustomerReview`, `GoogleReview`, `TeamMember`, `HowItWorks`, `Faq`, `Blog`, `SitePage`, `SiteSetting`, `Feedback`, `ContactEnquiry` |

Things worth knowing:

- A comic's genders, age groups and themes are **lists**; each needs at least
  one value.
- `Order` snapshots price and shipping address at checkout and never re-reads
  them from the session.
- `PageVersion.isSelected` marks the variants the customer chose to print.

---

## Engineering rules

These are load-bearing. Most of them exist because breaking them caused a real
bug.

1. **Status changes are guarded in the query.** Use
   `updateMany({ where: { id, status: <expected> } })` and check `count`. Only
   one concurrent caller can win the transition, and the winner is the one that
   emits events or sends email. Never read the status, check it in JavaScript,
   then write.
2. **Never call Redis or an external API inside `prisma.$transaction`.** Redis
   does not roll back with Postgres. Commit first, then enqueue.
3. **Enqueue with a meaningful `jobId`** so retries and duplicate webhooks are
   harmless.
4. **Webhooks are idempotent.** Each event is recorded in `WebhookEvent` with a
   unique `eventId` before any work; a duplicate insert means "already
   processed". Respond `400` only for permanent failures (bad signature);
   anything else is rethrown so the provider retries.
5. **Notifications never throw.** Wrap and log; the business flow must continue.
6. **Escape user input in emails.** Child names come from a public form — run
   every interpolated value through `escapeHtml`.
7. **Read configuration only through `config` from `config/env.ts`**, and add
   any new required variable to both `env.ts` and `.env.example`.
8. **Never hand-edit `src/generated/`** — change `schema.prisma` and regenerate.

### Patched dependency

`patches/opentype.js+2.0.0.patch` makes `opentype.js` skip font substitution
tables it doesn't support instead of crashing, which some comic fonts trigger.
It is applied automatically by `patch-package` on `npm install`. The Dockerfile
copies `patches/` **before** `npm ci` — keep it that way, or the patch silently
won't apply in the image.

---

## Database migrations

1. Edit `prisma/schema.prisma`.
2. Create the migration **without applying it**:
   `npx prisma migrate dev --create-only --name <short_description>`.
3. **Read the generated SQL.** Prisma happily writes `DROP COLUMN` when you
   rename or restructure a field, which deletes data. If existing data must
   survive, hand-edit the file: add the new shape, copy the data across, and
   only then drop the old columns.
   `20261006201804_comic_multi_gender_age_theme` is the cautionary example:
   it is Prisma's unedited output, and applying it wiped every comic's
   gender, age group and theme in production. It stays in the history
   because production has applied it — never edit or delete a migration that
   has already been applied anywhere; fix forward with a new one.
4. Apply it to your dev database (`npx prisma migrate deploy`), run
   `npx prisma generate`, then `npx tsc --noEmit`.
5. Commit the migration together with the code that depends on it.

---

## Working with webhooks locally

Razorpay and Shiprocket call the backend, so they can't reach `localhost`
directly. To exercise payment locally:

1. Expose the backend with a tunnel (for example `ngrok http 8080`).
2. In the Razorpay **test-mode** dashboard, point a webhook at
   `https://<tunnel>/api/webhooks/razorpay`, subscribe to `payment.captured`
   and `payment.failed`, and put its secret in `RAZORPAY_WEBHOOK_SECRET`.

Without a webhook, a test payment succeeds in Razorpay but the order stays
unpaid here, by design. Shiprocket webhooks are set up the same way, with
`SHIPROCKET_WEBHOOK_TOKEN` sent as the `x-api-key` header.

---

## Quality checks

There is no automated test suite. Before opening a PR:

- `npx tsc --noEmit` passes.
- You have exercised the changed flow end to end against your dev database.
- Any new environment variable is in `config/env.ts` **and** `.env.example`.
- Any schema change ships with its migration and a regenerated client.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server exits with `FATAL ERROR: Missing required environment variable` | A variable from `.env.example` is missing from `.env` |
| Type errors mentioning `src/generated/prisma` or unknown model fields | Run `npx prisma generate` |
| Pages stay "generating" forever | Redis not reachable, or RunPod credentials wrong — check the `[SD Worker]` log lines |
| Payment succeeds but the order stays unpaid | No Razorpay webhook is reaching the backend (see above) |
| Login works but the session isn't kept in the browser | Frontend and backend origins/cookie settings mismatch — `BETTER_AUTH_URL` must be this backend's public origin, and `NODE_ENV=production` enables cross-subdomain cookies |
| The first request after a cold start fails once | Neon cold start; retry |
