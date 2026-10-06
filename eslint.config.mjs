import tseslint from "typescript-eslint";

/**
 * Type-aware strict lint (issue #37).
 *
 * - strictTypeChecked + stylisticTypeChecked: semantic/type-aware rules only.
 *   Whitespace/formatting is prettier's job (.prettierrc.json, printWidth 100);
 *   these presets contain no formatting rules, so nothing duplicates prettier.
 * - Type information comes from each workspace's own tsconfig via
 *   projectService; repo-level scripts (scripts/) have the root tsconfig.json.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
      "bb/**",
      // pm-autopilot (#396): the extracted PM-harness product repo, consumed
      // as a pinned submodule with its own CI (typecheck + vitest) — same
      // submodule exemption as bb/.
      "pm-autopilot/**",
      // Tool configs, not product source: adding vitest.config.ts to a
      // package tsconfig program merges @cloudflare/vitest-plugin's bundled
      // workers-types with the package's own and breaks typecheck of real
      // source (bisected in #37). They stay prettier-formatted; wrangler.jsonc
      // is likewise outside the lint surface.
      "**/vitest.config.ts",
      "**/vitest.*.config.ts",
      // Research harness code under docs/research/spike/ is run-once
      // evidence (omp-runtime spike #125), dynamically importing an external
      // runtime: not product source, exempt from the type-aware battery.
      "docs/research/spike/**",
      // Bun-runtime tests (T5' #128 + M1.5 activation lane #95/#97/#98/#101):
      // run under `bun test` only — the omp runtime + eval kernel library
      // need Bun built-ins, so
      // they live in no tsc program (excluded from both daemon-service
      // tsconfigs) and the project service cannot type them.
      "packages/daemon-service/test/tool-runtime.test.ts",
      "packages/daemon-service/test/eval-kernel.test.ts",
      "packages/daemon-service/test/host-directory.test.ts",
      "packages/daemon-service/test/host-files.test.ts",
      "packages/daemon-service/test/l1-read-semantics.test.ts",
      "packages/daemon-service/test/l1-glob-grep-semantics.test.ts",
      "packages/daemon-service/test/l1-edit-semantics.test.ts",
      "packages/daemon-service/test/l1-find-semantics.test.ts",
      "packages/daemon-service/test/l1-task-isolation.test.ts",
      "packages/daemon-service/test/l1-security-scan.test.ts",
      "packages/daemon-service/test/l1-workspace-semantics.test.ts",
      "packages/daemon-service/test/l1-prompt-attachments.test.ts",
      // #420 CF Access header lane: same Bun-only shape (globalThis
      // fetch/WebSocket override drives the real client seam functions).
      "packages/daemon-service/test/l1-cf-access-headers.test.ts",
      // Node-ambient client test (moved to tsconfig.client.json — the
      // workers-side program's ambient set conflicts): outside the project
      // service's default tsconfig discovery, prettier-formatted only.
      "packages/daemon-service/test/l1-ws-close-reconnect.test.ts",
      // Vendored upstream code (matrix C2 #327): packages/mcp/src and
      // packages/mcp/test are a byte-identical direct port of
      // @earendil-works/pi-mcp 1.0.3 (see that package's README provenance
      // section) — editing them to satisfy repo lint would break the
      // re-vendor diff. The repo-owned surfaces of the package
      // (conformance/, packaging) stay fully linted.
      "packages/mcp/src/**",
      "packages/mcp/test/**",
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
  {
    // daemon-service's Bun/Node client and its scripts are typechecked
    // against Node types via the named tsconfig.client.json (the Workers and
    // Node ambient type sets overlap-and-conflict; see that package's
    // tsconfig.json). The project service only auto-discovers files named
    // tsconfig.json, so point these files at the client program explicitly.
    files: [
      "packages/daemon-service/src/client/**/*.ts",
      "packages/daemon-service/scripts/**/*.ts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["packages/daemon-service/tsconfig.client.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Object TYPE ALIASES are load-bearing in these files: type aliases (not
    // interfaces) carry implicit index signatures, required to satisfy
    // Record<string, SqlStorageValue> (daemon-worker Sql rows), the
    // AdapterCommandResultValue index-signature union (provider JSON
    // vocabulary) and Hono's Schema constraint (hdc Endpoint descriptors).
    // See the comments at each declaration. #37 sweep lesson: a mechanical
    // type→interface fix here breaks typecheck.
    files: [
      "apps/daemon-worker/src/host-orchestrator-do.ts",
      "apps/daemon-worker/src/provider-types.ts",
      "apps/server-worker/src/contract/hdc/common.ts",
      "apps/server-worker/src/contract/hdc/local.ts",
    ],
    rules: {
      "@typescript-eslint/consistent-type-definitions": "off",
    },
  },
);
