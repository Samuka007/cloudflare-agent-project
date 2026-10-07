-- #502 the experimental tool-capability 正本: the D1 seat behind GET/PUT
-- /system/tool-capabilities. A single row (id = 'tool_capabilities', the
-- image_source/web_search single-row precedent) carries the three #150 gates:
-- external_thinking → `think`, context_notes → context_notes + new_context,
-- checkpoint → checkpoint + rewind (1 = the tool family renders on the wire,
-- 0 = off). The row is ABSENT until an operator flips a gate — and the
-- absent-row posture is the omp default: all five tools OFF. The three
-- AGENT_DO_* deployment env gates are deleted (#502 zero-env ruling): D1 is
-- the only 正本, so a panel/face write hot-applies on the next turn.
--
-- Idempotent by the #295 replay contract (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS tool_capabilities (
  id TEXT PRIMARY KEY NOT NULL,
  external_thinking INTEGER NOT NULL DEFAULT 0,
  context_notes INTEGER NOT NULL DEFAULT 0,
  checkpoint INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
