/**
 * Experimental tool-capability posture. The D1 `tool_capabilities` row is the
 * sole 正本 (#502); the absent-row posture is omp's defaults (all off).
 */
export interface ExperimentalToolConfig {
  /** omp cfgExternalThinking — gates `think` (paired with forceReasoningOff). */
  externalThinking: boolean;
  /** omp cfgCompactionExperimentalContextManagement — gates context_notes + new_context. */
  contextNotes: boolean;
  /** omp checkpoint/rewind pair. */
  checkpoint: boolean;
}

export const DEFAULT_EXPERIMENTAL_TOOL_CONFIG: ExperimentalToolConfig = {
  externalThinking: false,
  contextNotes: false,
  checkpoint: false,
};
