CREATE TABLE `identity_ingestion_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`protocol` text NOT NULL,
	`network` text NOT NULL,
	`evidence_type` text NOT NULL,
	`cursor_start` text,
	`cursor_end` text,
	`range_start` text NOT NULL,
	`range_end` text NOT NULL,
	`record_count` integer NOT NULL,
	`activity_row_count` integer DEFAULT 0 NOT NULL,
	`checksum` text NOT NULL,
	`status` text DEFAULT 'importing' NOT NULL,
	`imported_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_segments_source_id_unique` ON `identity_ingestion_segments` (`source_key`,`id`);--> statement-breakpoint
CREATE INDEX `identity_segments_protocol_status_idx` ON `identity_ingestion_segments` (`protocol`,`status`,`range_start`);--> statement-breakpoint
CREATE TABLE `monthly_identity_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`segment_id` text NOT NULL,
	`role` text NOT NULL,
	`protocol` text NOT NULL,
	`network` text NOT NULL,
	`identity_scheme` text NOT NULL,
	`identity_hash` text NOT NULL,
	`activity_month` text NOT NULL,
	`transaction_count` integer NOT NULL,
	`volume_usd_micros` integer NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`evidence_level` text NOT NULL,
	FOREIGN KEY (`segment_id`) REFERENCES `identity_ingestion_segments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monthly_identity_segment_activity_unique` ON `monthly_identity_activity` (`segment_id`,`role`,`protocol`,`network`,`identity_hash`,`activity_month`);--> statement-breakpoint
CREATE INDEX `monthly_identity_cohort_idx` ON `monthly_identity_activity` (`role`,`protocol`,`activity_month`,`evidence_level`);--> statement-breakpoint
CREATE INDEX `monthly_identity_history_idx` ON `monthly_identity_activity` (`role`,`identity_hash`,`activity_month`);--> statement-breakpoint
CREATE INDEX `monthly_identity_segment_idx` ON `monthly_identity_activity` (`segment_id`);