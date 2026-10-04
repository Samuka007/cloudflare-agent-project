import type { Env } from "../env.js";
import { defaultAppSettings, type AppSettings } from "../contract/domain/app-settings.js";
import {
  defaultExperiments,
  experimentsSchema,
  type Experiments,
} from "../contract/domain/experiments.js";
import type { AppKeybindingOverrides } from "../contract/domain/app-keybindings.js";
import { toAppSettingsDbRow, type AppSettingsDbRow } from "./rows.js";

/**
 * app_settings / system_experiments / app_theme persistence, ported from bb
 * packages/db app-settings and experiments data modules (commit 8473d8c33).
 * Single-row app_settings keyed "app_settings"; experiments are key/value
 * rows; theme is single-row keyed "app_theme".
 */
export async function getAppSettingsRow(env: Env): Promise<AppSettingsDbRow | null> {
  const row = await env.DB.prepare(
    "SELECT caffeinate, show_keyboard_hints, steer_active_thread_on_enter, show_unhandled_provider_events, codex_memory_enabled, claude_code_memory_enabled, codex_subagents_disabled, claude_code_subagents_disabled, claude_code_workflows_disabled, keybinding_overrides, onboarding_completed_at, updated_at FROM app_settings WHERE id = 'app_settings'",
  ).first();
  return row ? toAppSettingsDbRow(row) : null;
}

export function toAppSettings(row: AppSettingsDbRow | null): AppSettings {
  if (!row) {
    return { ...defaultAppSettings };
  }
  return {
    caffeinate: row.caffeinate,
    showKeyboardHints: row.showKeyboardHints,
    steerActiveThreadOnEnter: row.steerActiveThreadOnEnter,
    showUnhandledProviderEvents: row.showUnhandledProviderEvents,
    codexMemoryEnabled: row.codexMemoryEnabled,
    claudeCodeMemoryEnabled: row.claudeCodeMemoryEnabled,
    codexSubagentsDisabled: row.codexSubagentsDisabled,
    claudeCodeSubagentsDisabled: row.claudeCodeSubagentsDisabled,
    claudeCodeWorkflowsDisabled: row.claudeCodeWorkflowsDisabled,
    onboardingCompletedAt: row.onboardingCompletedAt,
  };
}

/** bb setAppSettings: full-row replace (PUT /settings/general). */
export async function setAppSettings(env: Env, settings: AppSettings): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (id, caffeinate, show_keyboard_hints, steer_active_thread_on_enter, show_unhandled_provider_events, codex_memory_enabled, claude_code_memory_enabled, codex_subagents_disabled, claude_code_subagents_disabled, claude_code_workflows_disabled, keybinding_overrides, onboarding_completed_at, updated_at)
     VALUES ('app_settings', ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT keybinding_overrides FROM app_settings WHERE id = 'app_settings'), '[]'), ?, ?)
     ON CONFLICT(id) DO UPDATE SET caffeinate = excluded.caffeinate, show_keyboard_hints = excluded.show_keyboard_hints, steer_active_thread_on_enter = excluded.steer_active_thread_on_enter, show_unhandled_provider_events = excluded.show_unhandled_provider_events, codex_memory_enabled = excluded.codex_memory_enabled, claude_code_memory_enabled = excluded.claude_code_memory_enabled, codex_subagents_disabled = excluded.codex_subagents_disabled, claude_code_subagents_disabled = excluded.claude_code_subagents_disabled, claude_code_workflows_disabled = excluded.claude_code_workflows_disabled, onboarding_completed_at = excluded.onboarding_completed_at, updated_at = excluded.updated_at`,
  )
    .bind(
      settings.caffeinate ? 1 : 0,
      settings.showKeyboardHints ? 1 : 0,
      settings.steerActiveThreadOnEnter ? 1 : 0,
      settings.showUnhandledProviderEvents ? 1 : 0,
      settings.codexMemoryEnabled ? 1 : 0,
      settings.claudeCodeMemoryEnabled ? 1 : 0,
      settings.codexSubagentsDisabled ? 1 : 0,
      settings.claudeCodeSubagentsDisabled ? 1 : 0,
      settings.claudeCodeWorkflowsDisabled ? 1 : 0,
      settings.onboardingCompletedAt,
      Date.now(),
    )
    .run();
}

export async function getKeybindingOverrides(env: Env): Promise<AppKeybindingOverrides> {
  const row = await getAppSettingsRow(env);
  if (!row) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(row.keybindingOverridesJson);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as AppKeybindingOverrides;
  } catch {
    // bb: invalid overrides degrade to [] with an error log.
    console.error("invalid keybinding overrides stored; ignoring");
    return [];
  }
}

export async function setKeybindingOverrides(
  env: Env,
  overrides: AppKeybindingOverrides,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (id, keybinding_overrides, updated_at) VALUES ('app_settings', ?, ?)
     ON CONFLICT(id) DO UPDATE SET keybinding_overrides = excluded.keybinding_overrides, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify(overrides), Date.now())
    .run();
}

export async function getExperiments(env: Env): Promise<Experiments> {
  const merged: Experiments = { ...defaultExperiments };
  const { results } = await env.DB.prepare("SELECT key, value FROM system_experiments").all();
  for (const row of results) {
    const key = row.key;
    if (typeof key === "string" && key in merged) {
      merged[key as keyof Experiments] = Number(row.value) !== 0;
    }
  }
  return experimentsSchema.parse(merged);
}

export async function setExperiments(env: Env, experiments: Experiments): Promise<void> {
  const now = Date.now();
  const stmts = (Object.keys(experiments) as (keyof Experiments)[]).map((key) =>
    env.DB.prepare(
      `INSERT INTO system_experiments (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(key, experiments[key] ? 1 : 0, now),
  );
  await env.DB.batch(stmts);
}

export interface StoredAppearance {
  themeId: string;
  faviconColor: string | null;
}

export async function getStoredAppearance(env: Env): Promise<StoredAppearance | null> {
  const row = await env.DB.prepare(
    "SELECT theme_id, favicon_color FROM app_theme WHERE id = 'app_theme'",
  ).first<{ theme_id: string; favicon_color: string | null }>();
  return row
    ? {
        themeId: row.theme_id,
        faviconColor: row.favicon_color,
      }
    : null;
}

export async function setStoredAppearance(env: Env, appearance: StoredAppearance): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_theme (id, theme_id, favicon_color) VALUES ('app_theme', ?, ?)
     ON CONFLICT(id) DO UPDATE SET theme_id = excluded.theme_id, favicon_color = excluded.favicon_color`,
  )
    .bind(appearance.themeId, appearance.faviconColor)
    .run();
}

export { applyAppKeybindingOverrides } from "../contract/domain/app-keybindings.js";
