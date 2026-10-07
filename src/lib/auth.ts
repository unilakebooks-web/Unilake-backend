import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma.js";
import { config } from "../config/env.js";

const isProd = process.env.NODE_ENV === "production";

export const auth = betterAuth({
  baseURL: config.betterAuthUrl,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: config.googleId,
      clientSecret: config.googleSecret,
    },
    facebook: {
      clientId: config.facebookId,
      clientSecret: config.facebookSecret,
      mapProfileToUser: (profile) => {
        return {
          email: profile.email || `${profile.id}@facebook.local`,
          name: profile.name,
          image: profile.picture?.data?.url,
        };
      },
    },
  },
  user: {
    additionalFields: {
      role: {
        type: ["ADMIN", "USER"],
        required: false,
        defaultValue: "USER",
        input: false,
      },
    },
  },
  advanced: {
    defaultCookieAttributes: {
      sameSite: isProd ? "none" : "lax",
      secure: isProd,
      httpOnly: true,
    },
    // since we have the real domain now we have uncommentted this block
    crossSubDomainCookies: isProd
      ? { enabled: true, domain: ".unilakekids.com" }
      : { enabled: false },
  },
  trustedOrigins: [
    "http://localhost:3000",
    "https://www.unilakekids.com",
    "https://unilakekids.com",
  ],
});
