CREATE TABLE `job_triggers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_name` text NOT NULL,
	`requested_by_user_id` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`requested_at` integer DEFAULT (unixepoch()) NOT NULL,
	`claimed_at` integer,
	`finished_at` integer,
	`job_run_id` integer,
	`error_message` text,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_triggers_status_idx` ON `job_triggers` (`status`,`id`);