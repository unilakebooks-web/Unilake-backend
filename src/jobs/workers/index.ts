import { logger } from "../../lib/logger.js";
// import { hdWorker } from "./hdWorker.js";
import { pdfWorker } from "./pdfWorker.js";
import { shiprocketWorker } from "./shiprocketWorker.js";
import { generationWorker } from "./generationWorker.js";
import { sweepExpiredSessions } from "../../services/session.service.js";

// Hourly expiry sweep — audit 11.1.
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
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

  // Setup graceful shutdown handlers so active jobs aren't brutally cut off during server restarts
  const gracefulShutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Closing background workers gracefully...`);

    // Stop the sweeper first so it doesn't fire during shutdown.
    clearInterval(expirySweepTimer);
    
    // Close all workers in parallel
    await Promise.all(workers.map(worker => worker.close()));
    
    logger.info("All background workers closed cleanly.");
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
};