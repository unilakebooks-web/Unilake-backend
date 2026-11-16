import { defineConfig } from "vitest/config";

// Tests live in tests/ (not src/) so they are not copied into the production
// image, which only copies src and prisma.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
