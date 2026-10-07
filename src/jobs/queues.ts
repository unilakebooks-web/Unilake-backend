import { Queue, type DefaultJobOptions, } from "bullmq";
import { redisClient } from "../lib/redis.js";

const defaultJobOptions: DefaultJobOptions = {
    attempts : 3, // automatically retry failed jobs upto 3 tries
    backoff: {
        type : "exponential", 
        delay : 2000 // wait 2s , then 4s , then 8x between retries
    },
    removeOnComplete: {
        age: 24* 3600, // Keep completed jobs in Redis for 24 hours for debugging
        count : 1000, // Or keep the last 1000 completed jobs (whichever is stricter)
    },
    removeOnFail: {
        age : 7 * 24 * 3600, // Keep failed jobs in Redis for 7 days so we can inspect them
    },
};

/**
 * Queue for processing Standard Definition (SD) generations.
 * Used for fast, low-res preview generations.
 */
export const sdGenerationQueue = new Queue("sd-generation", {
  connection: redisClient,
  defaultJobOptions,
});

/**
 * Queue for processing High Definition (HD) generations.
 * Used for the final, computationally heavy upscaling tasks.
 */
// export const hdGenerationQueue = new Queue("hd-generation", {
//   connection: redisClient,
//   defaultJobOptions,
// });

/**
 * Queue for compiling finished generation assets into downloadable PDFs.
 */
export const pdfCompilationQueue = new Queue("pdf-compilation", {
  connection: redisClient,
  defaultJobOptions,
});

export const shiprocketQueue = new Queue("shiprocket", {
  connection: redisClient,
  defaultJobOptions,
});