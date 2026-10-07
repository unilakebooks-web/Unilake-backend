import type { Response } from "express";

export function sendSuccess<T>(
  res: Response,
  statusCode: number,
  data: T,
  message?: string
) {
  res.status(statusCode).json({
    success: true,
    ...(message ? { message } : {}),
    data,
  });
}
