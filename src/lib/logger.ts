// src/lib/logger.ts
import pino from "pino";
import { config } from "../config/env.js";

const isDev = config.nodeEnv === "development";

export const logger = pino({
  level: isDev ? "debug" : "info",
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    },
  }),
});