/**
 * Core five aggregate repositories (db campaign T3, #595): threads (⊃ tabs ⊃
 * pending push-write), projects (⊃ sources), hosts, environments, thread
 * sections. drizzle lives inside the factories; call sites see only plain
 * records and intent-named methods (zero SQL / query-builder leakage).
 *
 * The settings/provider aggregates joined in T4 (#596); T5/T6 re-point the
 * routes; T9 retires the legacy src/db SQL modules this barrel will
 * eventually replace.
 */
export * from "./environments";
export * from "./hosts";
export * from "./provider-configs";
export * from "./projects";
export * from "./settings";
export * from "./thread-sections";
export * from "./threads";
