// L1 fixture stand-in for the built cap-provider-config bundle: the plugin
// frontend is ESM whose default export is a definePluginApp definition, but
// the worker only ever serves bytes; the routes tests assert transport
// semantics (content types + cache policy), not module evaluation.
export {};
