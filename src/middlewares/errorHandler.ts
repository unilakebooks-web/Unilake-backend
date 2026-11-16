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


   // A request body that is not valid JSON, or is too large, is the caller's mistake: answer 400 or 413, not 500.
   const bodyErrorType = (err as { type?: string }).type;
   if (bodyErrorType === "entity.parse.failed" || bodyErrorType === "entity.too.large") {
       const tooLarge = bodyErrorType === "entity.too.large";
       res.status(tooLarge ? 413 : 400).json({
           success: false,
           error: {
               code: tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_JSON",
               message: tooLarge ? "The request body is too large." : "The request body is not valid JSON.",
           },
       });
       return;
   }

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