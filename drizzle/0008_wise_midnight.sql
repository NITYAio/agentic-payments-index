ALTER TABLE `daily_protocol_metrics` ADD `raw_transfer_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_protocol_metrics` ADD `recipient_volume_usd_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_protocol_metrics` ADD `gross_volume_usd_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `protocol_window_metrics` ADD `raw_transfer_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `protocol_window_metrics` ADD `recipient_volume_usd_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `protocol_window_metrics` ADD `gross_volume_usd_micros` integer DEFAULT 0 NOT NULL;