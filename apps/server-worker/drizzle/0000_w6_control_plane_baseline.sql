CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`project_id` text NOT NULL,
	`host_id` text NOT NULL,
	`path` text,
	`managed` integer DEFAULT false NOT NULL,
	`is_git_repo` integer DEFAULT false NOT NULL,
	`is_worktree` integer DEFAULT false NOT NULL,
	`branch_name` text,
	`base_branch` text,
	`default_branch` text,
	`merge_base_branch` text,
	`destroy_attempt_id` text,
	`retire_requested_at` integer,
	`workspace_provision_type` text NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_project_host_path_idx` ON `environments` (`project_id`,`host_id`,`path`);--> statement-breakpoint
CREATE INDEX `environments_host_path_lookup_idx` ON `environments` (`host_id`,`path`);--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);--> statement-breakpoint
CREATE INDEX `environments_status_idx` ON `environments` (`status`);--> statement-breakpoint
CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`connect_machine_id` text,
	`max_permission_mode` text DEFAULT 'full' NOT NULL,
	`destroyed_at` integer,
	`last_seen_at` integer,
	`last_rejected_protocol_version` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hosts_last_seen_idx` ON `hosts` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `project_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`type` text DEFAULT 'local_path' NOT NULL,
	`host_id` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_project_host_idx` ON `project_sources` (`project_id`,`host_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'standard' NOT NULL,
	`name` text NOT NULL,
	`git_remote_url` text,
	`sort_key` text DEFAULT 'V' NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_updated_idx` ON `projects` (`updated_at`);--> statement-breakpoint
CREATE INDEX `projects_deleted_idx` ON `projects` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `projects_sort_idx` ON `projects` (`sort_key`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_personal_singleton_idx` ON `projects` (`kind`) WHERE "projects"."kind" = 'personal';--> statement-breakpoint
CREATE TABLE `provider_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`base_url` text,
	`api` text,
	`service_tier` integer DEFAULT false NOT NULL,
	`api_key_enc` text,
	`models` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings_agent` (
	`id` text PRIMARY KEY NOT NULL,
	`permission_mode` text,
	`external_thinking` integer,
	`context_notes` integer,
	`checkpoint` integer,
	`compaction_method_order` text,
	`compaction_remote_provider_id` text,
	`compaction_remote_model` text,
	`image_source_provider_id` text,
	`web_search_chain` text,
	`web_search_timeout_seconds` integer,
	`web_search_engines` text,
	`web_search_secrets_enc` text,
	`web_search_secrets_meta` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "settings_agent_singleton_check" CHECK("settings_agent"."id" = 'agent')
);
--> statement-breakpoint
CREATE TABLE `settings_app` (
	`id` text PRIMARY KEY NOT NULL,
	`caffeinate` integer DEFAULT false NOT NULL,
	`show_keyboard_hints` integer DEFAULT true NOT NULL,
	`steer_active_thread_on_enter` integer DEFAULT false NOT NULL,
	`show_unhandled_provider_events` integer DEFAULT false NOT NULL,
	`codex_memory_enabled` integer DEFAULT true NOT NULL,
	`claude_code_memory_enabled` integer DEFAULT true NOT NULL,
	`codex_subagents_disabled` integer DEFAULT false NOT NULL,
	`claude_code_subagents_disabled` integer DEFAULT false NOT NULL,
	`claude_code_workflows_disabled` integer DEFAULT false NOT NULL,
	`keybinding_overrides` text DEFAULT '[]' NOT NULL,
	`onboarding_completed_at` text,
	`theme_id` text,
	`favicon_color` text,
	`origin_allowlist` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "settings_app_singleton_check" CHECK("settings_app"."id" = 'app')
);
--> statement-breakpoint
CREATE TABLE `system_experiments` (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `thread_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_sections_name_idx` ON `thread_sections` (`name`);--> statement-breakpoint
CREATE TABLE `thread_tabs` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`tabs_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text,
	`provider_id` text NOT NULL,
	`model_override` text,
	`reasoning_level_override` text,
	`title` text,
	`title_fallback` text,
	`section_id` text,
	`status` text DEFAULT 'starting' NOT NULL,
	`parent_thread_id` text,
	`source_thread_id` text,
	`origin_kind` text,
	`origin_plugin_id` text,
	`visibility` text DEFAULT 'visible' NOT NULL,
	`pending_since` integer,
	`pending_fold_seq` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`pinned_at` integer,
	`pin_sort_key` text,
	`deleted_at` integer,
	`last_read_at` integer,
	`latest_attention_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`section_id`) REFERENCES `thread_sections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `threads_project_updated_idx` ON `threads` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `threads_project_archived_deleted_idx` ON `threads` (`project_id`,`archived_at`,`deleted_at`,`id`);--> statement-breakpoint
CREATE INDEX `threads_pin_sort_idx` ON `threads` (`archived_at`,`deleted_at`,`pin_sort_key`,`id`) WHERE "threads"."pinned_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `threads_environment_idx` ON `threads` (`environment_id`);--> statement-breakpoint
CREATE INDEX `threads_parent_idx` ON `threads` (`parent_thread_id`);--> statement-breakpoint
CREATE INDEX `threads_source_origin_idx` ON `threads` (`source_thread_id`,`origin_kind`);--> statement-breakpoint
CREATE INDEX `threads_section_archived_deleted_idx` ON `threads` (`section_id`,`archived_at`,`deleted_at`,`id`);--> statement-breakpoint
CREATE INDEX `threads_archived_status_idx` ON `threads` (`archived_at`,`status`);