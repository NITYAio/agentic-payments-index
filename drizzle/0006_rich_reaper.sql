DROP INDEX `daily_protocol_metrics_source_date_unique`;--> statement-breakpoint
ALTER TABLE `daily_protocol_metrics` ADD `charge_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_protocol_metrics` ADD `session_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_protocol_metrics` ADD `charge_volume_usd_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_protocol_metrics` ADD `session_volume_usd_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `daily_protocol_metrics_run_date_unique` ON `daily_protocol_metrics` (`run_id`,`activity_date`,`measurement_unit`);--> statement-breakpoint
ALTER TABLE `protocol_window_metrics` ADD `charge_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `protocol_window_metrics` ADD `session_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `protocol_window_metrics` ADD `charge_volume_usd_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `protocol_window_metrics` ADD `session_volume_usd_micros` integer DEFAULT 0 NOT NULL;