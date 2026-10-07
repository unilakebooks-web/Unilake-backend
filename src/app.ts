import express from "express";
import helmet from "helmet";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { requireAdmin } from "./middlewares/requireAdmin.js";
import adminRoutes from "./routes/admin.js";
import publicRouter from "./routes/public.js";
import userRouter from "./routes/user.js";
import { requireLoggedIn } from "./middlewares/requireLoggedIn.js";
import webhookRouter from "./routes/webhooks.js";

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const app = express();
app.set("trust proxy", 1);

const allowedOrigins = [
  "https://www.unilakekids.com",   // canonical production frontend
  "https://unilakekids.com",       // apex — redirects to www, but be safe
  "http://localhost:3000",         // local dev
];

// app.use(
//   pinoHttp({
//     logger: logger,
//   })
// );
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header = same-origin navigation, curl, or Render's health check.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);

      // Vercel preview deployments get a fresh URL per branch.
      // Public endpoints will work from these; anything needing a login will not
      // (the cookie is scoped to .unilakekids.com). Drop this block if you don't
      // want previews talking to production data.
      if (/^https:\/\/unilake-frontend-[a-z0-9-]+\.vercel\.app$/.test(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  })
);
app.use(helmet());
app.all("/api/auth/*splat", toNodeHandler(auth));

// Webhooks must be mounted BEFORE express.json() so signature verification
// can read the exact raw bytes as sent by the provider. Same pattern as Better Auth.
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhookRouter);

app.use(express.json());

app.get("/health", (req, res) => {
  res.send("Server is wroking perfectly fine!");
});
app.use("/api/admin", requireAdmin, adminRoutes);
app.use("/api/user", requireLoggedIn, userRouter);
app.use("/api/public", publicRouter);

app.use(errorHandler);

export default app;
