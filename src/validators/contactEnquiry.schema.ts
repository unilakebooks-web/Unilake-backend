import { z } from "zod";

// Unlike Feedback — which is anonymous by design and deliberately collects no
// contact details — an enquiry exists to be answered. Email and phone are the
// reply channel, so both are required rather than optional.
export const createContactEnquirySchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().email("Enter a valid email address"),
  // Loose on purpose. We ship internationally (the Country table drives
  // domestic vs international Shiprocket routing), so a regex tuned to
  // 10-digit Indian numbers would silently reject legitimate overseas
  // enquirers. This rejects empty and junk input without pretending to
  // validate dialling plans.
  phone: z
    .string()
    .trim()
    .min(7, "Enter a valid contact number")
    .max(20, "Contact number is too long")
    .regex(
      /^[\d+\-()\s]+$/,
      "Contact number may only contain digits, spaces and + - ( )"
    ),
  // Matches the textarea's maxLength on the client. Feedback caps only on the
  // client and accepts unbounded text server-side; that gap is not copied here.
  message: z
    .string()
    .trim()
    .min(1, "Message is required")
    .max(2000, "Message must be 2000 characters or less"),
});

export const contactEnquiryFilterQuerySchema = z.object({
  status: z
    .enum(["OPEN", "VIEWED", "RESOLVED", "DISMISSED"], {
      message: "Invalid status. Must be OPEN, VIEWED, RESOLVED, or DISMISSED.",
    })
    .optional(),
});

export const updateContactEnquiryStatusSchema = z.object({
  status: z.enum(["OPEN", "VIEWED", "RESOLVED", "DISMISSED"], {
    message: "Status must be OPEN, VIEWED, RESOLVED, or DISMISSED",
  }),
});
