import { z } from "zod";
import { MAX_BULK_GENERATE } from "../config/coupon.js";
import {
  isValidCouponCode,
  normalizeCouponCode,
  parseValidityInput,
} from "../utils/couponCode.js";

// Per-field rules only. Rules that span several fields (a percentage coupon
// needs a percentage, a fixed one needs a currency, the end after the start...)
// live in utils/couponShape.ts so create and update apply the same ones.

const hasAtMostTwoDecimals = (value: number) =>
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

const money = (label: string) =>
  z
    .number({ message: `${label} must be a number` })
    .positive(`${label} must be greater than 0`)
    .refine(hasAtMostTwoDecimals, {
      message: `${label} can have at most 2 decimal places`,
    });

const couponCodeSchema = z
  .string()
  .transform(normalizeCouponCode)
  .refine(isValidCouponCode, {
    message:
      "Code must be 4 to 32 characters: letters, digits and hyphens only",
  });

const discountTypeEnum = z.enum(["PERCENT", "FIXED"], {
  message: "discountType must be PERCENT or FIXED",
});

const kindEnum = z.enum(["PUBLIC", "SINGLE_USE"], {
  message: "kind must be PUBLIC or SINGLE_USE",
});

const coverTypeEnum = z.enum(["HARDCOVER", "SOFTCOVER"], {
  message: "coverType must be HARDCOVER or SOFTCOVER",
});

const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), {
    message: "Currency must be a 3-letter code such as INR",
  });

const countryCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{2}$/.test(value), {
    message: "Country must be a 2-letter code such as IN",
  });

// The admin enters dates in IST: "2026-12-31" means the start or the end of
// that day in India, and a full date-time must carry an offset.
const validityDate = (edge: "start" | "end") =>
  z.string().transform((value, ctx) => {
    const date = parseValidityInput(value, edge);
    if (date === null) {
      ctx.addIssue({
        code: "custom",
        message:
          "Use a real date as YYYY-MM-DD (read as IST), or a date-time with an offset",
      });
      return z.NEVER;
    }
    return date;
  });

const limitSchema = z
  .number({ message: "Limit must be a number" })
  .int("Limit must be a whole number")
  .min(1, "Limit must be at least 1");

export const createCouponSchema = z.object({
  // Leave the code out to have one generated.
  code: couponCodeSchema.optional(),
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(500).optional(),
  kind: kindEnum.default("PUBLIC"),

  discountType: discountTypeEnum,
  percentOff: money("Percentage").optional(),
  amountOff: money("Amount").optional(),
  maxDiscount: money("Maximum discount").optional(),
  currency: currencySchema.optional(),

  startsAt: validityDate("start").optional(),
  endsAt: validityDate("end").optional(),

  usageLimit: limitSchema.optional(),
  perCustomerLimit: limitSchema.optional(),

  restrictedToUserId: z.string().trim().min(1).optional(),

  allComics: z.boolean().default(true),
  comicIds: z.array(z.string().uuid("comicIds must be UUIDs")).default([]),
  countryCodes: z.array(countryCodeSchema).default([]),
  coverTypes: z.array(coverTypeEnum).default([]),

  combinable: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

// Every field optional on update; null clears an optional field.
export const updateCouponSchema = z
  .object({
    code: couponCodeSchema.optional(),
    name: z.string().trim().min(1, "Name cannot be empty").max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    kind: kindEnum.optional(),

    discountType: discountTypeEnum.optional(),
    percentOff: money("Percentage").nullable().optional(),
    amountOff: money("Amount").nullable().optional(),
    maxDiscount: money("Maximum discount").nullable().optional(),
    currency: currencySchema.nullable().optional(),

    startsAt: validityDate("start").nullable().optional(),
    endsAt: validityDate("end").nullable().optional(),

    usageLimit: limitSchema.nullable().optional(),
    perCustomerLimit: limitSchema.nullable().optional(),

    restrictedToUserId: z.string().trim().min(1).nullable().optional(),

    allComics: z.boolean().optional(),
    comicIds: z.array(z.string().uuid("comicIds must be UUIDs")).optional(),
    countryCodes: z.array(countryCodeSchema).optional(),
    coverTypes: z.array(coverTypeEnum).optional(),

    combinable: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

// Bulk creation of single-use codes: the same rules for every code, a count in
// place of a code, and the kind and usage limit fixed by the service.
export const generateCouponsSchema = createCouponSchema
  .omit({ code: true, kind: true, usageLimit: true })
  .extend({
    count: z
      .number({ message: "count must be a number" })
      .int("count must be a whole number")
      .min(1, "count must be at least 1")
      .max(MAX_BULK_GENERATE, `count cannot be more than ${MAX_BULK_GENERATE}`),
  });

// Query schema — parsed in the controller, there is no validateQuery middleware.
export const listCouponsQuerySchema = z.object({
  // Query strings arrive as strings; coerce to number and default.
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["active", "inactive"]).optional(),
  kind: kindEnum.optional(),
  search: z.string().trim().min(1).optional(),
});

export type CreateCouponInput = z.infer<typeof createCouponSchema>;
export type UpdateCouponInput = z.infer<typeof updateCouponSchema>;
export type GenerateCouponsInput = z.infer<typeof generateCouponsSchema>;
export type ListCouponsQueryInput = z.infer<typeof listCouponsQuerySchema>;
