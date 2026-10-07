import dotenv from "dotenv";

dotenv.config();

const requriedVariables = [
  "PORT",
  "DATABASE_URL",
  "DIRECT_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_PRIVATE_BUCKET_NAME",
  "R2_PUBLIC_BUCKET_NAME",
  "R2_ENDPOINT",
  "R2_PUBLIC_URL_BASE",
  "REDIS_URL",
  "FACEBOOK_CLIENT_ID",
  "FACEBOOK_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "RUNPOD_ENDPOINT_ID",
  "RUNPOD_API_KEY",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "SHIPROCKET_EMAIL",
  "SHIPROCKET_PASSWORD",
  "SHIPROCKET_PICKUP_LOCATION_NAME",
  "SHIPROCKET_WEBHOOK_TOKEN",
  "RESEND_API_KEY",
  "EMAIL_FROM_ADDRESS",
  "EMAIL_FROM_NAME",
  "FRONTEND_URL",
] as const;

for (const envVar of requriedVariables) {
  if (!process.env[envVar]) {
    console.error(
      `🚨 FATAL ERROR: Missing required environment variable: ${envVar}`
    );
    process.exit(1);
  }
}

export const config = {
  port: parseInt(process.env.PORT as string, 10),
  nodeEnv: process.env.NODE_ENV || "development",
  DATABASE_URL: process.env.DATABASE_URL,
  DIRECT_URL: process.env.DIRECT_URL,
  googleId: process.env.GOOGLE_CLIENT_ID as string,
  googleSecret: process.env.GOOGLE_CLIENT_SECRET as string,
  betterAuthUrl: process.env.BETTER_AUTH_URL as string,
  facebookId: process.env.FACEBOOK_CLIENT_ID as string,
  facebookSecret: process.env.FACEBOOK_CLIENT_SECRET as string,
  // Public origin of the Next.js frontend, used to build links in customer
  // emails. Trailing slashes are stripped so `${frontendUrl}/path` never
  // doubles them. Local: http://localhost:3000. Production:
  // https://www.unilakekids.com — never the *.vercel.app domain, where login
  // does not work.
  frontendUrl: (process.env.FRONTEND_URL as string).replace(/\/+$/, ""),
  r2: {
    accountId: process.env.R2_ACCOUNT_ID as string,
    accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
    privateBucket: process.env.R2_PRIVATE_BUCKET_NAME as string,
    publicBucket: process.env.R2_PUBLIC_BUCKET_NAME as string,
    endpoint: process.env.R2_ENDPOINT as string,
    publicUrlBase: process.env.R2_PUBLIC_URL_BASE as string,
  },
  redis: {
    url: process.env.REDIS_URL as string,
  },
  runpod: {
    endpointId: process.env.RUNPOD_ENDPOINT_ID as string,
    apiKey: process.env.RUNPOD_API_KEY as string,
  },
  razorpay: {
    razorpayKeyId: process.env.RAZORPAY_KEY_ID!,
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET!,
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET!,
  },
  shiprocket: {
    email: process.env.SHIPROCKET_EMAIL!,
    password: process.env.SHIPROCKET_PASSWORD!,
    pickupLocationName: process.env.SHIPROCKET_PICKUP_LOCATION_NAME!,
    webhookToken: process.env.SHIPROCKET_WEBHOOK_TOKEN!,
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY!,
    fromAddress: process.env.EMAIL_FROM_ADDRESS!,
    fromName: process.env.EMAIL_FROM_NAME!,
  },
};
