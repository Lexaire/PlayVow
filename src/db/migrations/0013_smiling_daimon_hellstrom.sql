ALTER TABLE `group_secrets` ADD `steamgifts_cookie_updated_by_user_id` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `group_secrets` ADD `steamgifts_cookie_last_tested_at` integer;--> statement-breakpoint
ALTER TABLE `group_secrets` ADD `steamgifts_cookie_last_test_result` text;--> statement-breakpoint
ALTER TABLE `group_secrets` ADD `steamgifts_cookie_last_success_at` integer;