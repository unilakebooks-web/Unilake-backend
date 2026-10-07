import { z } from "zod";

/**
 * Optional free-text field. Omitted = unchanged, null = clear the column.
 * Empty strings are rejected — clearing is what null is for, and allowing both
 * means two ways to express the same state.
 */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} cannot be empty — omit it or send null to clear it`)
    .max(max, `${label} is too long`)
    .nullable()
    .optional();

/** Optional social/profile link. Same omitted/null semantics as above. */
const optionalUrl = (label: string) =>
  z
    .string()
    .trim()
    .url(`${label} must be a valid URL`)
    .nullable()
    .optional();

/**
 * Hosts allowed to be embedded as the contact-page map.
 *
 * This matters more than it looks: whatever is stored here is rendered inside
 * an <iframe> on a public page. An unconstrained URL turns the settings form
 * into an admin-side injection vector — anyone who gets into the admin panel
 * could frame arbitrary third-party content on the site. Restricting the host
 * closes that off, at the cost of not supporting other map providers.
 *
 * Covers google.com, google.co.in, google.co.uk and the rest of the ccTLDs.
 */
const GOOGLE_MAPS_HOST = /^(www\.)?google\.(com|co\.[a-z]{2}|[a-z]{2})$/;

const mapEmbedUrlSchema = z
  .string()
  .trim()
  .url("Map embed URL must be a valid URL")
  .refine(
    (value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }

      // http:// would be blocked by the browser on an https page anyway, and
      // silently render nothing — reject it here where we can say why.
      if (parsed.protocol !== "https:") return false;

      return GOOGLE_MAPS_HOST.test(parsed.hostname);
    },
    {
      message:
        "Map embed URL must be an https:// Google Maps link (use the 'Embed a map' share option in Google Maps).",
    }
  )
  .nullable()
  .optional();

/**
 * Body for PATCH /site-settings.
 *
 * Every field is optional: the admin fills this in progressively and a
 * half-complete settings form must still save. Omitted leaves a column
 * untouched, null clears it — the upsert in the service relies on that
 * distinction, so do not relax these to plain `.optional()`.
 *
 * Phone numbers are deliberately loose. International formats vary too much
 * for a regex that does not eventually reject someone's real number.
 */
export const updateSiteSettingSchema = z
  .object({
    // ---- Store status ----
    // The one NOT NULL column on this model, so unlike every other field here
    // it is `.optional()` WITHOUT `.nullable()` — omitted still means "leave
    // alone", but "clear it" is not a meaningful operation on a boolean.
    //
    // The admin panel deliberately sends this on its own, from a dedicated
    // toggle, and never as part of the contact-details form: a form that
    // submitted every field would write its own stale copy of this flag back
    // on every save, silently re-opening the store.
    acceptingOrders: z.boolean().optional(),

    // ---- Brand ----
    brandDescription: optionalText(1000, "Brand description"),

    // ---- Contact page intro ----
    headline: optionalText(200, "Headline"),
    description: optionalText(2000, "Description"),

    // ---- Contact channels ----
    email: z
      .string()
      .trim()
      .email("Must be a valid email address")
      .nullable()
      .optional(),
    phone: optionalText(30, "Phone"),
    whatsappPhone: optionalText(30, "WhatsApp number"),
    businessHours: optionalText(200, "Business hours"),

    // ---- Address ----
    addressLine1: optionalText(200, "Address line 1"),
    addressLine2: optionalText(200, "Address line 2"),
    city: optionalText(100, "City"),
    state: optionalText(100, "State"),
    zip: optionalText(20, "ZIP"),
    country: optionalText(100, "Country"),
    mapEmbedUrl: mapEmbedUrlSchema,

    // ---- SEO ----
    // Site-wide fallback title/description, used by any page that has nothing
    // more specific (the homepage, and anything without its own meta fields).
    //
    // The limits are deliberately ABOVE what search engines display — Google
    // truncates around 60 and 160 characters. The admin panel shows a counter
    // and warns past those, but still allows saving, so rejecting at 60/160
    // here would turn that soft warning into a hard failure.
    metaTitle: optionalText(120, "Meta title"),
    metaDescription: optionalText(320, "Meta description"),

    // ---- Socials ----
    instagramUrl: optionalUrl("Instagram URL"),
    facebookUrl: optionalUrl("Facebook URL"),
    twitterUrl: optionalUrl("Twitter URL"),
    youtubeUrl: optionalUrl("YouTube URL"),
    linkedinUrl: optionalUrl("LinkedIn URL"),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided to update",
  });

export type UpdateSiteSettingInput = z.infer<typeof updateSiteSettingSchema>;
