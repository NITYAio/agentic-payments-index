CREATE TABLE `daily_protocol_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_key` text NOT NULL,
	`protocol` text NOT NULL,
	`network` text NOT NULL,
	`activity_date` text NOT NULL,
	`measurement_unit` text NOT NULL,
	`transaction_count` integer NOT NULL,
	`settlement_count` integer NOT NULL,
	`volume_usd_micros` integer NOT NULL,
	`buyer_count` integer NOT NULL,
	`seller_count` integer NOT NULL,
	`evidence_level` text NOT NULL,
	`is_adjusted` integer DEFAULT false NOT NULL,
	`limitation` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `source_ingestion_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_protocol_metrics_source_date_unique` ON `daily_protocol_metrics` (`source_key`,`protocol`,`network`,`activity_date`,`measurement_unit`);--> statement-breakpoint
CREATE INDEX `daily_protocol_metrics_query_idx` ON `daily_protocol_metrics` (`protocol`,`network`,`activity_date`,`measurement_unit`);--> statement-breakpoint
CREATE INDEX `daily_protocol_metrics_run_idx` ON `daily_protocol_metrics` (`run_id`);--> statement-breakpoint
CREATE TABLE `source_coverage` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`protocol` text NOT NULL,
	`network` text NOT NULL,
	`measurement_unit` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text NOT NULL,
	`coverage_start` text,
	`coverage_end` text,
	`last_successful_sync_at` text,
	`status` text NOT NULL,
	`limitation` text NOT NULL,
	`methodology_url` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_coverage_scope_unique` ON `source_coverage` (`source_key`,`protocol`,`network`,`measurement_unit`);--> statement-breakpoint
CREATE INDEX `source_coverage_protocol_idx` ON `source_coverage` (`protocol`,`network`,`status`);--> statement-breakpoint
CREATE TABLE `source_ingestion_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`protocol` text NOT NULL,
	`network` text NOT NULL,
	`collector_version` text NOT NULL,
	`range_start` text NOT NULL,
	`range_end` text NOT NULL,
	`query_hash` text NOT NULL,
	`input_row_count` integer DEFAULT 0 NOT NULL,
	`metric_row_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'importing' NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`error_message` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_ingestion_runs_source_id_unique` ON `source_ingestion_runs` (`source_key`,`id`);--> statement-breakpoint
CREATE INDEX `source_ingestion_runs_protocol_range_idx` ON `source_ingestion_runs` (`protocol`,`network`,`range_start`,`status`);