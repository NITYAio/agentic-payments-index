CREATE TABLE `public_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`route` text NOT NULL,
	`client_hash` text NOT NULL,
	`window_start` integer NOT NULL,
	`request_count` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `public_rate_limits_window_idx` ON `public_rate_limits` (`route`,`window_start`);