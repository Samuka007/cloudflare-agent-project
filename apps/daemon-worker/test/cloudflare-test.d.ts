// Ambient worker-types reference: the plugin's `cloudflare:test` module only
// exists as a declaration file, so a triple-slash reference is the standard
// mechanism here (an import would scope the ambient module declaration).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../node_modules/@cloudflare/vitest-plugin/types/cloudflare-test.d.ts" />
