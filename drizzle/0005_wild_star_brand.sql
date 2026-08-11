CREATE TABLE `protocol_window_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_key` text NOT NULL,
	`protocol` text NOT NULL,
	`network` text NOT NULL,
	`range_start` text NOT NULL,
	`range_end` text NOT NULL,
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
CREATE UNIQUE INDEX `protocol_window_metrics_scope_unique` ON `protocol_window_metrics` (`source_key`,`protocol`,`network`,`range_start`,`range_end`,`measurement_unit`);--> statement-breakpoint
CREATE INDEX `protocol_window_metrics_query_idx` ON `protocol_window_metrics` (`protocol`,`network`,`range_end`,`measurement_unit`);--> statement-breakpoint
CREATE INDEX `protocol_window_metrics_run_idx` ON `protocol_window_metrics` (`run_id`);