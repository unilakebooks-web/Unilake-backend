import {Redis} from "ioredis"
import { config } from "../config/env.js"
import { logger } from "./logger.js"


declare global {
    var _redisClient: Redis | undefined
}

const connectionOptions = {
    maxRetriesPerRequest: null,// this command here is required by bull MQ and stops the redis from retrying the job on its own and let the BullMQ handle the retry or backoff logic on its own
}

export const redisClient = global._redisClient || new Redis(config.redis.url, connectionOptions)

if (config.nodeEnv !== "production") {
  global._redisClient = redisClient;
}

redisClient.on("ready", () => {
    logger.info("Succesfully connected to Redis")
})

redisClient.on("error", (error) => {
    logger.error({err: error}, "Redis connection error")
})