/**
 * Social sign-in without an address gets a made-up one (`<id>@facebook.local`, lib/auth.ts). Such an address
 * can never be mailed, so no reminder or broadcast goes to one.
 */
export const isPlaceholderAddress = (email: string): boolean =>
  /@[^@]*\.local$/i.test(email);
