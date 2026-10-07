import { z } from "zod";

export const getCustomerReviewUploadUrlSchema = z.object({
  fileName: z.string().min(1, "File name is required"),
  contentType: z
    .string()
    .regex(
      /^video\/(mp4|webm|mov|quicktime)$/,
      "Only MP4, WebM, and MOV videos are allowed"
    ),
});


export const createCustomerReviewSchema = z.object({
  customerName: z.string().trim().min(1, "Customer name is required"),
  description: z.string().trim().min(1, "Description is required"),
  videoKey: z.string().min(1, "Video key is required"),
});

