CREATE TABLE `cohort_snapshot_cells` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`role` text NOT NULL,
	`mode` text NOT NULL,
	`cohort_month` text NOT NULL,
	`offset` integer NOT NULL,
	`calendar_month` text NOT NULL,
	`cohort_size` integer NOT NULL,
	`retained` integer NOT NULL,
	`left_censored` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `cohort_snapshot_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cohort_snapshot_cell_unique` ON `cohort_snapshot_cells` (`run_id`,`role`,`mode`,`cohort_month`,`offset`);--> statement-breakpoint
CREATE INDEX `cohort_snapshot_query_idx` ON `cohort_snapshot_cells` (`run_id`,`role`,`mode`,`cohort_month`);--> statement-breakpoint
CREATE TABLE `cohort_snapshot_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`protocol` text NOT NULL,
	`source_keys_json` text NOT NULL,
	`coverage_start` text NOT NULL,
	`coverage_end` text NOT NULL,
	`complete_through` text NOT NULL,
	`checksum` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'importing' NOT NULL,
	`imported_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cohort_snapshot_protocol_checksum_unique` ON `cohort_snapshot_runs` (`protocol`,`checksum`);--> statement-breakpoint
CREATE INDEX `cohort_snapshot_protocol_status_idx` ON `cohort_snapshot_runs` (`protocol`,`status`,`complete_through`);