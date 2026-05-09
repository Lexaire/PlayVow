ALTER TABLE `job_runs` ADD `triggered_by` text DEFAULT 'cron' NOT NULL;--> statement-breakpoint
ALTER TABLE `job_runs` ADD `triggered_by_user_id` integer REFERENCES users(id);