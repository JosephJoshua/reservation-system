CREATE TABLE `coach_days_off` (
	`coach_id` integer NOT NULL,
	`date` text NOT NULL,
	PRIMARY KEY(`coach_id`, `date`),
	FOREIGN KEY (`coach_id`) REFERENCES `coaches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `coach_hours` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`coach_id` integer NOT NULL,
	`weekday` integer NOT NULL,
	`start_minute` integer NOT NULL,
	`end_minute` integer NOT NULL,
	`lesson_minutes` integer NOT NULL,
	FOREIGN KEY (`coach_id`) REFERENCES `coaches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `coach_hours_coach` ON `coach_hours` (`coach_id`);--> statement-breakpoint
ALTER TABLE `bookings` ADD `attendance` text;--> statement-breakpoint
ALTER TABLE `bookings` ADD `attendance_at` integer;--> statement-breakpoint
ALTER TABLE `bookings` ADD `coach_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookings` ADD `coach_told_booked_at` integer;--> statement-breakpoint
ALTER TABLE `bookings` ADD `coach_told_cancelled_at` integer;--> statement-breakpoint
ALTER TABLE `coaches` ADD `openid` text;--> statement-breakpoint
ALTER TABLE `coaches` ADD `bind_code` text;--> statement-breakpoint
ALTER TABLE `coaches` ADD `bind_code_expires_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `coaches_openid_unique` ON `coaches` (`openid`);--> statement-breakpoint
CREATE UNIQUE INDEX `coaches_bind_code_unique` ON `coaches` (`bind_code`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `coach_id` integer REFERENCES coaches(id);--> statement-breakpoint
ALTER TABLE `slots` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
-- Bookings made before coach notifications existed are not announced.
UPDATE `bookings` SET `coach_told_booked_at` = unixepoch() * 1000, `coach_told_cancelled_at` = unixepoch() * 1000;
