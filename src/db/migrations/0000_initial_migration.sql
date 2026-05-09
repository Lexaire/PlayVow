CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` integer,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `giveaways` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`steamgifts_code` text NOT NULL,
	`steam_app_id` integer,
	`steam_sub_id` integer,
	`creator_user_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`scraped_at` integer NOT NULL,
	`slug` text,
	`winners_scraped_at` integer,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`steam_app_id`) REFERENCES `steam_apps`(`app_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`steam_sub_id`) REFERENCES `steam_subs`(`sub_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `giveaways_group_code_uniq` ON `giveaways` (`group_id`,`steamgifts_code`);--> statement-breakpoint
CREATE INDEX `giveaways_group_ended_idx` ON `giveaways` (`group_id`,`ended_at`);--> statement-breakpoint
CREATE TABLE `group_secrets` (
	`group_id` integer PRIMARY KEY NOT NULL,
	`steamgifts_cookie_encrypted` text,
	`steamgifts_cookie_updated_at` integer,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`play_window_days` integer NOT NULL,
	`steamgifts_group_code` text NOT NULL,
	`steam_group_id` text NOT NULL,
	`steam_group_slug` text NOT NULL,
	`description` text,
	`last_scraped_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_slug_unique` ON `groups` (`slug`);--> statement-breakpoint
CREATE TABLE `steam_apps` (
	`app_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`icon_hash` text,
	`last_synced_at` integer
);
--> statement-breakpoint
CREATE TABLE `steam_subs` (
	`sub_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`last_synced_at` integer
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`steamgifts_username` text NOT NULL,
	`steam_id` text,
	`avatar_url` text,
	`profile_visibility` integer,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_steamgifts_username_unique` ON `users` (`steamgifts_username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_steam_id_unique` ON `users` (`steam_id`);--> statement-breakpoint
CREATE TABLE `win_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`win_id` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`current_playtime_minutes` integer NOT NULL,
	`has_review` integer,
	`screenshot_count` integer,
	`achievements_unlocked` integer,
	`achievements_total` integer,
	FOREIGN KEY (`win_id`) REFERENCES `wins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `win_observations_win_observed_idx` ON `win_observations` (`win_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `wins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`giveaway_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`won_at` integer NOT NULL,
	`play_deadline` integer NOT NULL,
	`playtime_at_win_minutes` integer,
	`current_playtime_minutes` integer,
	`has_review` integer,
	`screenshot_count` integer,
	`achievements_unlocked` integer,
	`achievements_total` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_checked_at` integer,
	`resolved_at` integer,
	`mod_notes` text,
	FOREIGN KEY (`giveaway_id`) REFERENCES `giveaways`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wins_giveaway_user_uniq` ON `wins` (`giveaway_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `wins_status_deadline_idx` ON `wins` (`status`,`play_deadline`);--> statement-breakpoint
CREATE INDEX `wins_user_idx` ON `wins` (`user_id`);