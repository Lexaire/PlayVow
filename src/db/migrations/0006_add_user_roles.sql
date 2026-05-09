ALTER TABLE `users` ALTER COLUMN "steamgifts_username" TO "steamgifts_username" text;--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);
