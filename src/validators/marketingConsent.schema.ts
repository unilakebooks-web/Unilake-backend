import { z } from "zod";

/** Body of PUT /user/marketing-consent: only the choice. Who it is for comes from the session. */
export const marketingConsentSchema = z
  .object({ optedIn: z.boolean() })
  .strict();
