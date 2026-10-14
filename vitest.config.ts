import { defineConfig } from "vitest/config";

// Tests import workspace packages from their TypeScript source, through the
// "source" export condition, so they need no build first.
export default defineConfig({
  ssr: { resolve: { conditions: ["source"] } },
});
