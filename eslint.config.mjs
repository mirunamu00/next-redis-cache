// ESLint flat config shared by source, tests and scripts.
// Only the non-type-aware recommended rules are used (fast, identical on Windows and Linux).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "reports/**",
      ".work/**",
      ".artifacts/**",
      "test-apps/**/.next/**",
      "test-apps/**/node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Unused arguments are marked with a leading underscore (common when matching Next.js interface signatures)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
