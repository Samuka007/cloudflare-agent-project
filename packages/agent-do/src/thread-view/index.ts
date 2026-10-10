/**
 * #560 thread-view barrel: the ux→bb StoredEventRow materializer and the bb
 * thread-view projection pipeline the server-worker's switched face
 * (services/thread-view.ts) consumes.
 */
export {
  materializeUxWindowToStoredEventRows,
  type UxThreadEventEnvelope,
} from "./materializer.js";
export {
  projectUxWindowThroughThreadView,
  type UxWindowThreadViewOptions,
  type UxWindowThreadViewProjection,
} from "./projection.js";
