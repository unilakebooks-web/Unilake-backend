import type { Request, Response, NextFunction} from "express";
import { logger } from "../lib/logger.js";
import { config } from "../config/env.js";
import { AppError } from "../utils/errors.js";


export const errorHandler = (
    err: Error | AppError,
    req: Request,
    res: Response,
    next: NextFunction
) => {
   // 1. log error using pino
   logger.error(err, `Error caught on ${req.method}, ${req.originalUrl}`)


   // 2. Determine the status code or set the status coode to default 500 internal server error
   const statusCode = err instanceof AppError ? err.statusCode : 500;

   // 3. Determine string based error code
   const errorCode = err instanceof AppError ? err.code : "INTERNAL_SERVER_ERROR";
   
   // 4. sanitize the messageif its  500 based error hide the real message to prevent the leaking in the server details
   const isDev = config.nodeEnv === "development";
   const message = statusCode === 500 && !isDev
   ? "An unexpected error occurred on the server."
   : err.message

   // 5. return the request
   res.status(statusCode).json({
    success : false,
    error: {
        code: errorCode,
        message: message,
    }
   })
}