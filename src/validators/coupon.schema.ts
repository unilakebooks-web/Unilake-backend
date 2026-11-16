import { z } from "zod";
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

// Largest values the database columns hold: Decimal(10,2) and a 32-bit integer.
const MAX_MONEY = 99999999.99;
const MAX_LIMIT = 2147483647;

const money = (label: string) =>
  z
    .number({ message: `${label} must be a number` })
    .positive(`${label} must be greater than 0`)
    .max(MAX_MONEY, `${label} cannot be more than 99,999,999.99`)
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
          "Use a real date (years 2000 to 2100) as YYYY-MM-DD (read as IST), or a date-time with an offset",
      });
      return z.NEVER;
    }
    return date;
  });

const limitSchema = z
  .number({ message: "Limit must be a number" })
  .int("Limit must be a whole number")
  .min(1, "Limit must be at least 1")
  .max(MAX_LIMIT, "Limit cannot be more than 2,147,483,647");

// Repeats are dropped and the list is capped, so a request cannot store
// thousands of copies of one value.
const uniqueList = <T extends z.ZodType>(item: T, max: number, what: string) =>
  z
    .array(item)
    .max(max, `Choose at most ${max} ${what}`)
    .transform((values) => [...new Set(values)]);

export const createCouponSchema = z.object({
  // Leave the code out to have one generated.
  code: couponCodeSchema.optional(),
  // How long a generated code is (used only when no code is given).
  codeLength: z
    .number({ message: "Code length must be a number" })
    .int("Code length must be a whole number")
    .min(4, "Code length must be at least 4")
    .max(32, "Code length cannot be more than 32")
    .optional(),
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
  countryCodes: uniqueList(countryCodeSchema, 250, "countries").default([]),
  coverTypes: uniqueList(coverTypeEnum, 2, "cover types").default([]),

  combinable: z.boolean().default(false),
  showAtCheckout: z.boolean().default(false),
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
    countryCodes: uniqueList(countryCodeSchema, 250, "countries").optional(),
    coverTypes: uniqueList(coverTypeEnum, 2, "cover types").optional(),

    combinable: z.boolean().optional(),
    showAtCheckout: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

// Optional body of PATCH /admin/coupons/:id/status. With isActive the coupon is
// set to exactly that; without it the status is flipped, as before.
export const couponStatusBodySchema = z.object({
  isActive: z.boolean({ message: "isActive must be true or false" }).optional(),
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
export type CouponStatusBodyInput = z.infer<typeof couponStatusBodySchema>;
export type ListCouponsQueryInput = z.infer<typeof listCouponsQuerySchema>;

// Query of the customer search used when a coupon is reserved for one customer.
export const searchCustomersQuerySchema = z.object({
  search: z.string().trim().min(2, "Type at least 2 characters"),
});
