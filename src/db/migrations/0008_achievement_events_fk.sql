-- Add surrogate integer PK + steam_apps FK to steam_achievements, then
-- replace (app_id, apiname) on achievement_events with achievement_id FK.
-- Backfill joins events to achievements on (app_id, apiname) — verified
-- zero orphans on prod prior to writing this migration.

CREATE TABLE `__new_steam_achievements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` integer NOT NULL,
	`apiname` text NOT NULL,
	`display_name` text,
	`description` text,
	`icon_url` text,
	`gray_icon_url` text,
	`hidden` integer,
	`last_synced_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `steam_apps`(`app_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_steam_achievements` (`app_id`, `apiname`, `display_name`, `description`, `icon_url`, `gray_icon_url`, `hidden`, `last_synced_at`)
SELECT `app_id`, `apiname`, `display_name`, `description`, `icon_url`, `gray_icon_url`, `hidden`, `last_synced_at` FROM `steam_achievements`;
--> statement-breakpoint
DROP TABLE `steam_achievements`;
--> statement-breakpoint
ALTER TABLE `__new_steam_achievements` RENAME TO `steam_achievements`;
--> statement-breakpoint
CREATE UNIQUE INDEX `steam_achievements_app_apiname_uniq` ON `steam_achievements` (`app_id`,`apiname`);
--> statement-breakpoint
CREATE TABLE `__new_achievement_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`achievement_id` integer NOT NULL,
	`win_id` integer NOT NULL,
	`achieved` integer NOT NULL,
	`unlocked_at` integer,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`achievement_id`) REFERENCES `steam_achievements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`win_id`) REFERENCES `wins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_achievement_events` (`id`, `user_id`, `achievement_id`, `win_id`, `achieved`, `unlocked_at`, `observed_at`)
SELECT ae.`id`, ae.`user_id`, sa.`id`, ae.`win_id`, ae.`achieved`, ae.`unlocked_at`, ae.`observed_at`
FROM `achievement_events` ae
JOIN `steam_achievements` sa ON sa.`app_id` = ae.`app_id` AND sa.`apiname` = ae.`apiname`;
--> statement-breakpoint
DROP TABLE `achievement_events`;
--> statement-breakpoint
ALTER TABLE `__new_achievement_events` RENAME TO `achievement_events`;
--> statement-breakpoint
CREATE INDEX `achievement_events_key_idx` ON `achievement_events` (`user_id`,`achievement_id`,`id`);
--> statement-breakpoint
CREATE INDEX `achievement_events_win_idx` ON `achievement_events` (`win_id`);
