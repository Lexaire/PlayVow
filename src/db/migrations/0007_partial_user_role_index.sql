DROP INDEX `users_role_idx`;--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`) WHERE role != 'user';