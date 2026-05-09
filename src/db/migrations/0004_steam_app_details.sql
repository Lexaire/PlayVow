ALTER TABLE `steam_apps` DROP COLUMN `icon_hash`;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `asset_small_capsule` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `asset_main_capsule` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `asset_header` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `asset_hero_capsule` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `asset_library_capsule` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `asset_library_hero` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `asset_community_icon` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `asset_page_background` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `asset_url_format` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `release_date` integer;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `short_description` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `app_type` integer;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `review_score` integer;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `review_score_label` text;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `review_percent_positive` integer;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `review_count` integer;--> statement-breakpoint
ALTER TABLE `steam_apps` ADD `details_synced_at` integer;