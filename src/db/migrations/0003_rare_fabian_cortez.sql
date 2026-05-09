DROP INDEX "achievement_events_key_idx";--> statement-breakpoint
DROP INDEX "achievement_events_win_idx";--> statement-breakpoint
DROP INDEX "audit_log_target_idx";--> statement-breakpoint
DROP INDEX "giveaways_group_code_uniq";--> statement-breakpoint
DROP INDEX "giveaways_group_ended_idx";--> statement-breakpoint
DROP INDEX "groups_slug_unique";--> statement-breakpoint
DROP INDEX "steam_achievements_app_apiname_uniq";--> statement-breakpoint
DROP INDEX "users_steamgifts_username_unique";--> statement-breakpoint
DROP INDEX "users_steam_id_unique";--> statement-breakpoint
DROP INDEX "win_observations_win_observed_idx";--> statement-breakpoint
DROP INDEX "wins_giveaway_user_uniq";--> statement-breakpoint
DROP INDEX "wins_status_deadline_idx";--> statement-breakpoint
DROP INDEX "wins_user_idx";--> statement-breakpoint
ALTER TABLE `win_observations` ALTER COLUMN "current_playtime_minutes" TO "current_playtime_minutes" integer;--> statement-breakpoint
CREATE INDEX `achievement_events_key_idx` ON `achievement_events` (`user_id`,`app_id`,`apiname`,`id`);--> statement-breakpoint
CREATE INDEX `achievement_events_win_idx` ON `achievement_events` (`win_id`);--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `giveaways_group_code_uniq` ON `giveaways` (`group_id`,`steamgifts_code`);--> statement-breakpoint
CREATE INDEX `giveaways_group_ended_idx` ON `giveaways` (`group_id`,`ended_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `groups_slug_unique` ON `groups` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `steam_achievements_app_apiname_uniq` ON `steam_achievements` (`app_id`,`apiname`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_steamgifts_username_unique` ON `users` (`steamgifts_username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_steam_id_unique` ON `users` (`steam_id`);--> statement-breakpoint
CREATE INDEX `win_observations_win_observed_idx` ON `win_observations` (`win_id`,`observed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `wins_giveaway_user_uniq` ON `wins` (`giveaway_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `wins_status_deadline_idx` ON `wins` (`status`,`play_deadline`);--> statement-breakpoint
CREATE INDEX `wins_user_idx` ON `wins` (`user_id`);