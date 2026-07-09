import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // The email templates are .tsx; use the automatic JSX runtime like Next does.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
