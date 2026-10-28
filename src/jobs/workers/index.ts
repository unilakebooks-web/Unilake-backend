import { logger } from "../../lib/logger.js";
// import { hdWorker } from "./hdWorker.js";
import { pdfWorker } from "./pdfWorker.js";
import { shiprocketWorker } from "./shiprocketWorker.js";
import { generationWorker } from "./generationWorker.js";
import { sweepExpiredSessions } from "../../services/session.service.js";
import { sweepStuckPageVersions } from "./stuckPageSweeper.js";

// Hourly expiry sweep — audit 11.1.
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Stuck-page sweep. First run shortly after boot — a restart is exactly when
// stuck pages appear — but late enough for Redis and the DB to connect.
const STUCK_PAGE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STUCK_PAGE_FIRST_SWEEP_MS = 60 * 1000; // 1 minute
/**
 * Initializes all background workers and registers graceful shutdown handlers.
 */
export const initJobs = () => {
  logger.info("Initializing background job workers...");

  // Instantiate/activate the workers by referencing them
  const workers = [generationWorker, pdfWorker, shiprocketWorker];

  logger.info(`All ${workers.length} workers are actively listening to their respective queues.`);

  // First run fires after the interval, not on boot. Overlapping runs across instances are safe (updateMany no-ops duplicates).
  const expirySweepTimer = setInterval(() => {
    sweepExpiredSessions().catch((err) => {
      logger.error({ err }, "[Expiry Sweeper] Sweep failed");
    });
  }, EXPIRY_SWEEP_INTERVAL_MS);

  logger.info(
    { intervalMinutes: EXPIRY_SWEEP_INTERVAL_MS / 60000 },
    "Expiry sweeper scheduled"
  );

  const runStuckPageSweep = () => {
    sweepStuckPageVersions().catch((err) => {
      logger.error({ err }, "[Stuck Page Sweeper] Sweep failed");
    });
  };

  const stuckPageFirstSweepTimer = setTimeout(
    runStuckPageSweep,
    STUCK_PAGE_FIRST_SWEEP_MS
  );
  const stuckPageSweepTimer = setInterval(
    runStuckPageSweep,
    STUCK_PAGE_SWEEP_INTERVAL_MS
  );

  logger.info(
    { intervalMinutes: STUCK_PAGE_SWEEP_INTERVAL_MS / 60000 },
    "Stuck page sweeper scheduled"
  );

  // Setup graceful shutdown handlers so active jobs aren't brutally cut off during server restarts
  const gracefulShutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Closing background workers gracefully...`);

    // Stop the sweepers first so they don't fire during shutdown.
    clearInterval(expirySweepTimer);
    clearTimeout(stuckPageFirstSweepTimer);
    clearInterval(stuckPageSweepTimer);
    
    // Close all workers in parallel
    await Promise.all(workers.map(worker => worker.close()));
    
    logger.info("All background workers closed cleanly.");
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
};