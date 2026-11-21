import { z } from "zod";

/** A button link in a bulk email goes out under our name: https only, no `user@` part. */
function isSafeButtonUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

const oneLine = (value: string) => !/[\r\n]/.test(value);

const fields = {
  subject: z
    .string()
    .trim()
    .min(1, "Subject is required")
    .max(150, "Subject is too long")
    .refine(oneLine, "Subject must be one line"),
  heading: z
    .string()
    .trim()
    .min(1, "Heading is required")
    .max(120, "Heading is too long")
    .refine(oneLine, "Heading must be one line"),
  message: z
    .string()
    .trim()
    .min(1, "Message is required")
    .max(5000, "Message is too long"),
  buttonText: z
    .string()
    .trim()
    .min(1, "Button text cannot be empty, leave the button out instead")
    .max(40, "Button text is too long")
    .nullable()
    .optional(),
  buttonUrl: z
    .string()
    .trim()
    .max(2000, "Button link is too long")
    .refine(isSafeButtonUrl, "Button link must be a valid https:// link")
    .nullable()
    .optional(),
  audience: z.enum(["OPTED_IN_ONLY", "OPTED_IN_AND_CUSTOMERS"]).optional(),
};

const buttonPair = (data: {
  buttonText?: string | null;
  buttonUrl?: string | null;
}) => (data.buttonText == null) === (data.buttonUrl == null);
const buttonPairMessage = {
  message: "Give both the button text and the button link, or neither",
  path: ["buttonUrl"],
};

export const createBroadcastSchema = z
  .object(fields)
  .refine(buttonPair, buttonPairMessage);

/**
 * Every field optional (omitted = unchanged). The button pair is checked in the service against the merged
 * values, because a partial body can legitimately carry only one half.
 */
export const updateBroadcastSchema = z
  .object({
    subject: fields.subject.optional(),
    heading: fields.heading.optional(),
    message: fields.message.optional(),
    buttonText: fields.buttonText,
    buttonUrl: fields.buttonUrl,
    audience: fields.audience,
  })
  .refine((data) => Object.keys(data).length > 0, "Nothing to update");

/** Send must say how many people the admin saw, so a list that changed in between is not sent unseen. */
export const startBroadcastSchema = z.object({
  confirmRecipientCount: z.number().int().min(1),
});

export type CreateBroadcastInput = z.infer<typeof createBroadcastSchema>;
export type UpdateBroadcastInput = z.infer<typeof updateBroadcastSchema>;
