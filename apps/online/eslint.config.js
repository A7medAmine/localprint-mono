import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

// Unused code and empty blocks are errors: the tree is clean, and CI keeps it
// that way. Accessibility rules cover the checks that a keyboard or screen
// reader user actually feels (an icon-only button with no name, a click handler
// on a div). `exhaustive-deps` stays a warning — the remaining hits are
// deliberate one-shot effects that need judgement, not a mechanical fix.
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
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          // `const { secret, ...rest } = obj` is how a response is stripped of
          // internal fields; the omitted name is the point, not a mistake.
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "off",
      // Electron preload/main + some CJS interop legitimately need require().
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Accessibility: the subset that catches real breakage rather than style.
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/anchor-has-content": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-role": "error",
      "jsx-a11y/label-has-associated-control": ["warn", { assert: "either", depth: 4 }],
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/role-has-required-aria-props": "error",
    },
  },
);
