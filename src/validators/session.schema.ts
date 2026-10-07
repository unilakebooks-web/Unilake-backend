import { z } from "zod";

export const createSessionSchema = z.object({
  comicId: z.string().uuid(),
});

export const updateSessionSchema = z.object({
  childName: z.string().min(1).max(50).optional(),
  age: z.number().int().min(0).max(18).optional(),
  pronounKey: z.enum(['HE', 'SHE', 'THEY']).optional(),
  notificationEmail: z.string().email("Invalid email address").optional(),
  coverType: z.enum(['HARDCOVER', 'SOFTCOVER']).optional(),
  shippingName: z.string().min(1).max(100).optional(),
  shippingLine1: z.string().min(1).max(200).optional(),
  shippingLine2: z.string().max(200).optional(),
  shippingCity: z.string().min(1).max(100).optional(),
  shippingState: z.string().min(1).max(100).optional(),
  shippingZip: z.string().min(1).max(20).optional(),
  shippingCountry: z.string().length(2, "Must be a 2-letter ISO country code").optional(),
  shippingPhone: z.string().min(5).max(20).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: 'At least one field must be provided',
});


export const photoUploadUrlSchema = z.object({
  fileExtension: z.enum(['jpg', 'jpeg', 'png', 'webp'], {
    message: "Invalid file extension. Must be strictly jpg, jpeg, png, or webp.",
  }),
});

export const photoConfirmSchema  = z.object({
  key: z.string({ message: "Upload key is required." }).min(1, "Upload key cannot be empty."),
});


export type PhotoConfirmInput = z.infer<typeof photoConfirmSchema>;;
export type PhotoUploadUrlInput = z.infer<typeof photoUploadUrlSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;