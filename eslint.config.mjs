import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript", "prettier"),
  {
    ignores: [".next/**", "node_modules/**", "drizzle/meta/**", "next-env.d.ts"],
  },
  {
    // All Plaid calls go through modules/connections/plaid.ts (plan.md §2).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/modules/connections/plaid.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "plaid",
              message: "Import Plaid only via modules/connections/plaid.ts.",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
