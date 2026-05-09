CREATE TABLE `steam_group_memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`steam_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`left_at` integer,
	`is_sticky` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sgm_group_steam_joined_uniq` ON `steam_group_memberships` (`group_id`,`steam_id`,`joined_at`);--> statement-breakpoint
CREATE INDEX `sgm_group_open_idx` ON `steam_group_memberships` (`group_id`) WHERE left_at IS NULL;--> statement-breakpoint
CREATE INDEX `sgm_steam_open_idx` ON `steam_group_memberships` (`steam_id`) WHERE left_at IS NULL;--> statement-breakpoint
ALTER TABLE `groups` ADD `last_steam_members_scraped_at` integer;