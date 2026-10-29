ALTER TABLE `bookings` ADD `coach_notice_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bookings` ADD `coach_notice_retry_at` integer;--> statement-breakpoint
ALTER TABLE `bookings` ADD `coach_notice_kind` text;--> statement-breakpoint
ALTER TABLE `idempotency_keys` ADD `student_id` integer;--> statement-breakpoint
ALTER TABLE `slots` ADD `coach_notice_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `slots` ADD `coach_notice_retry_at` integer;--> statement-breakpoint
ALTER TABLE `slots` ADD `coach_notice_kind` text;