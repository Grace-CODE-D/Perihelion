// ESLint flat config for the TypeScript workspaces (sdk, solver, relayer, mempool).
//
// Run from the repo root with `npm run lint`. Type-aware rules read
// `tsconfig.eslint.json`, which covers every TypeScript workspace including
// test files that the per-package tsconfigs exclude. `tsc --noEmit` remains the
// `typecheck` script in each workspace.
//
// @ts-check
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.config.*",
      "**/*.mjs",
      "**/*.cjs",
      "contracts/**",
      // Truncated on main (an editor placeholder replaced the end of the file),
      // so they do not parse. Restore them and drop these entries.
      "mempool/test/contract.test.ts",
      "mempool/test/server.test.ts",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    // Inference-heavy rules report on existing production code that is not yet
    // clean. They stay visible as warnings; the promise rules below are the
    // ones that guard signature and settlement paths, so they stay errors.
    rules: {
      "@typescript-eslint/require-await": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-enum-comparison": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
    },
  },
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Switch off the formatting rules that Prettier owns.
  eslintConfigPrettier,
  {
    // Test files are not yet clean under the type-aware rules (several hundred
    // un-awaited `assert.rejects`-style calls and `any`-typed fixtures). The
    // rules below stay enforced for production sources; tighten this block as
    // the test suites are migrated.
    files: ["**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
);
