import { defineConfig } from "vitest/config";

// Tests live in tests/ (not src/) so they are not copied into the production
// image, which only copies src and prisma.
//
// Integration tests talk to the Neon test branch (about 350 ms per round trip
// from India), so the timeouts are generous.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
