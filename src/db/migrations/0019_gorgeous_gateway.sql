-- Make SG-only fields on `groups` nullable so manual-source groups can omit
-- them. Steam group fields stay nullable too — manual groups can opt in to
-- roster tracking by setting them, but they're not required.
ALTER TABLE `groups` ALTER COLUMN "steamgifts_group_code" TO "steamgifts_group_code" text;--> statement-breakpoint
ALTER TABLE `groups` ALTER COLUMN "steam_group_id" TO "steam_group_id" text;--> statement-breakpoint
ALTER TABLE `groups` ALTER COLUMN "steam_group_slug" TO "steam_group_slug" text;--> statement-breakpoint

-- Discriminator: 'steamgifts' (scraped) vs 'manual' (admin-created).
ALTER TABLE `groups` ADD `source` text DEFAULT 'steamgifts' NOT NULL;--> statement-breakpoint

-- Manual giveaways have no SG code; relax the column and switch the unique
-- index to a partial one that only enforces uniqueness when the code is set.
ALTER TABLE `giveaways` ALTER COLUMN "steamgifts_code" TO "steamgifts_code" text;--> statement-breakpoint
DROP INDEX `giveaways_group_code_uniq`;--> statement-breakpoint
CREATE UNIQUE INDEX `giveaways_group_code_uniq` ON `giveaways` (`group_id`,`steamgifts_code`) WHERE steamgifts_code IS NOT NULL;--> statement-breakpoint

-- Soft-delete marker for manual giveaways. Read paths filter on
-- `deleted_at IS NULL`; the audit log is the permanent record of the action.
ALTER TABLE `giveaways` ADD `deleted_at` integer;
