import tseslint from "typescript-eslint";
import globals from "globals";

// Root config lints only root-level tooling files. Each app and package keeps
// its own eslint.config.js (run via `npm run lint --workspaces`). Phase 4.6
// unifies these and promotes the rules toward error.
export default tseslint.config(
  {
    ignores: ["apps/**", "packages/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,js}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
