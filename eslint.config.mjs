import tseslint from "typescript-eslint";

/**
 * Type-aware strict lint (issue #37).
 *
 * - strictTypeChecked + stylisticTypeChecked: semantic/type-aware rules only.
 *   Whitespace/formatting is prettier's job (.prettierrc.json, printWidth 100);
 *   these presets contain no formatting rules, so nothing duplicates prettier.
 * - Type information comes from each workspace's own tsconfig via
 *   projectService; repo-level scripts (scripts/) have the root tsconfig.json.
 * - daemon-service is intentionally skipped this round: sibling lanes #35/#36
 *   own that package. TODO(#37 remainder): drop this ignore when they land.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
      "bb/**",
      "packages/daemon-service/**",
      // Tool configs, not product source: adding vitest.config.ts to a
      // package tsconfig program merges @cloudflare/vitest-plugin's bundled
      // workers-types with the package's own and breaks typecheck of real
      // source (bisected in #37). They stay prettier-formatted; wrangler.jsonc
      // is likewise outside the lint surface.
      "**/vitest.config.ts",
      "**/vitest.*.config.ts",
    ],
  },
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // engineering.md: async discipline (Lint row) + FSM exhaustiveness
      // (practice #9) as enforced errors, not aspirations.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      // Preset override, the single deliberate one: template literals may
      // interpolate `number` (allowNumber). Numbers stringify losslessly in
      // TS and `${seq}`/`${port}` are pervasive wire-log idioms here; every
      // other strictness (any/boolean/nullish/regexp/never banned) stays on,
      // so `string | undefined`, `any` and `never` interpolations still fail.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
