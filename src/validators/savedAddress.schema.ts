import { z } from "zod";

// Address line 2 is required for every NEW or EDITED address. Addresses saved
// before this rule may still have it null in the DB; they stay usable at
// checkout (a business decision), and editing one only requires line2 if the
// edit touches it — update keeps it optional, but never empty or null.
export const createAddressSchema = z.object({
  label: z.string().min(1).max(50).optional(),
  name: z.string().min(1, "Recipient name is required").max(100),
  line1: z.string().min(1, "Address line 1 is required").max(200),
  line2: z.string().trim().min(1, "Address line 2 is required").max(200),
  city: z.string().min(1, "City is required").max(100),
  state: z.string().min(1, "State is required").max(100),
  zip: z.string().min(1, "ZIP/postal code is required").max(20),
  country: z.string().length(2, "Must be a 2-letter ISO country code"),
  phone: z.string().min(5, "Phone number too short").max(20, "Phone number too long"),
});

export const updateAddressSchema = z.object({
  // null clears the label; an empty string is still rejected.
  label: z.string().min(1).max(50).nullable().optional(),
  name: z.string().min(1).max(100).optional(),
  line1: z.string().min(1).max(200).optional(),
  line2: z.string().trim().min(1, "Address line 2 is required").max(200).optional(),
  city: z.string().min(1).max(100).optional(),
  state: z.string().min(1).max(100).optional(),
  zip: z.string().min(1).max(20).optional(),
  country: z.string().length(2, "Must be a 2-letter ISO country code").optional(),
  phone: z.string().min(5).max(20).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

export type CreateAddressInput = z.infer<typeof createAddressSchema>;
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;