import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// Phase 4.0 baseline: intentionally LENIENT. Goal is signal, not a churn storm.
// Unused vars warn (not error); hooks rules error. No formatting rules (editors
// own that). Phase 4.6 promotes these toward error once the tree is deduped.
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "release/**",
      "build/**",
      "node_modules/**",
      "uploads/**",
      "public/**",
      "tailwind.min.js",
      "**/*.min.js",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      // Electron preload/main + some CJS interop legitimately need require().
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": "warn",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
