CREATE TABLE `achievement_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`app_id` integer NOT NULL,
	`win_id` integer NOT NULL,
	`apiname` text NOT NULL,
	`achieved` integer NOT NULL,
	`unlocked_at` integer,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`win_id`) REFERENCES `wins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `achievement_events_key_idx` ON `achievement_events` (`user_id`,`app_id`,`apiname`,`id`);--> statement-breakpoint
CREATE INDEX `achievement_events_win_idx` ON `achievement_events` (`win_id`);--> statement-breakpoint
CREATE TABLE `steam_achievements` (
	`app_id` integer NOT NULL,
	`apiname` text NOT NULL,
	`display_name` text,
	`description` text,
	`icon_url` text,
	`gray_icon_url` text,
	`hidden` integer,
	`last_synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steam_achievements_app_apiname_uniq` ON `steam_achievements` (`app_id`,`apiname`);