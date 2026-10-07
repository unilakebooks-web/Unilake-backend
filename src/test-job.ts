// src/test-job.ts
import { sdGenerationQueue } from "./jobs/queues.js";
import { logger } from "./lib/logger.js"; // Adjust path if necessary

const runTest = async () => {
  logger.info("Injecting test job into the SD Generation Queue...");

  // Add a fake job to the queue
  const job = await sdGenerationQueue.add("generate-preview", {
    prompt: "A cinematic shot of a cyberpunk city, neon lights, 4k",
    sessionId: "test_session_999",
    userId: "test_user_1",
  });

  logger.info(`✅ Successfully added test job with ID: ${job.id}`);
  
  // Close the connection so the script can exit cleanly
  process.exit(0);
};

runTest().catch((err) => {
  logger.error({ err }, "Failed to inject test job");
  process.exit(1);
});