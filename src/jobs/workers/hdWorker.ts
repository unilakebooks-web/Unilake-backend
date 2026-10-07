// import { Worker, type Job } from "bullmq";
// import { redisClient } from "../../lib/redis.js";
// import { logger } from "../../lib/logger.js";

// export const hdWorker = new Worker(
//   "hd-generation",
//   async (job: Job) => {
//     logger.info({ jobId: job.id, name: job.name }, "[HD Worker] Picked up new job");
    
//     await new Promise((resolve) => setTimeout(resolve, 1500));

//     logger.info({ jobId: job.id }, "[HD Worker] Stub processing complete");
//     return { success: true, message: "HD generation stub completed" };
//   },
//   { connection: redisClient, concurrency: 1 }
// );

// hdWorker.on("failed", (job, err) => {
//   logger.error({ jobId: job?.id, err }, "[HD Worker] Job failed");
// });