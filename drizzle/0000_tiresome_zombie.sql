CREATE TABLE `service_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`service_name` text NOT NULL,
	`canonical_url` text NOT NULL,
	`protocol` text NOT NULL,
	`network` text NOT NULL,
	`protocol_endpoint` text NOT NULL,
	`contact_email` text NOT NULL,
	`challenge` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`verification_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`verified_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_submissions_canonical_url_unique` ON `service_submissions` (`canonical_url`);