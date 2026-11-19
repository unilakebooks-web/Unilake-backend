// Must be the FIRST import of every integration test.
//
// Loads .env.test (git-ignored; create it by hand, see README "Quality checks") and refuses to
// continue unless it points at the dedicated test database. Imports run in
// order, so this finishes before any test imports the app (which reads the
// environment the moment it loads).
import dotenv from "dotenv";

dotenv.config({ path: ".env.test", override: true });

const testHost = process.env.UNILAKE_TEST_DB_HOST;

if (process.env.UNILAKE_TEST_DATABASE !== "1" || !testHost) {
  throw new Error(
    "Refusing to run integration tests: .env.test is missing or does not mark itself as the test database."
  );
}

for (const name of ["DATABASE_URL", "DIRECT_URL"] as const) {
  if (!process.env[name]?.includes(testHost)) {
    throw new Error(
      `Refusing to run integration tests: ${name} does not point at the test database host.`
    );
  }
}

if (process.env.NODE_ENV === "production") {
  throw new Error(
    "Refusing to run integration tests with NODE_ENV=production."
  );
}

// Tests that delete stored files must only ever see the local MinIO bucket, never a real R2 account.
const r2Endpoint = process.env.R2_ENDPOINT ?? "";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(r2Endpoint)) {
  throw new Error(
    "Refusing to run integration tests: R2_ENDPOINT is not a local MinIO address."
  );
}
