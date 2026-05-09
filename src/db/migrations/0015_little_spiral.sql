CREATE TABLE `worker_heartbeats` (
	`id` integer PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`pid` integer NOT NULL
);
