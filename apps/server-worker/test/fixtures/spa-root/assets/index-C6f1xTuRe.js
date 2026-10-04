// Minimal L1 fixture bundle (ticket #47): the vitest assets root points at
// test/fixtures/spa-root, so the suite never depends on the gitignored
// public/ build output.
export const fixture = "c6-immutable-serving";
