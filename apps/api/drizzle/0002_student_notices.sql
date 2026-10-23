CREATE TABLE `student_notices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`booking_id` integer NOT NULL,
	`kind` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`done_at` integer,
	`result` text,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `student_notices_once` ON `student_notices` (`booking_id`,`kind`) WHERE kind in ('booked', 'cancelled', 'reminder');--> statement-breakpoint
CREATE INDEX `student_notices_booking` ON `student_notices` (`booking_id`,`kind`);--> statement-breakpoint
CREATE INDEX `student_notices_pending` ON `student_notices` (`done_at`);--> statement-breakpoint
-- Bookings made before student notices existed are not announced or reminded about.
INSERT INTO `student_notices` (`booking_id`, `kind`, `done_at`, `result`) SELECT `id`, 'booked', unixepoch() * 1000, 'skipped' FROM `bookings` WHERE `status` = 'confirmed';--> statement-breakpoint
INSERT INTO `student_notices` (`booking_id`, `kind`, `done_at`, `result`) SELECT `id`, 'reminder', unixepoch() * 1000, 'skipped' FROM `bookings` WHERE `status` = 'confirmed';--> statement-breakpoint
INSERT INTO `student_notices` (`booking_id`, `kind`, `done_at`, `result`) SELECT `id`, 'cancelled', unixepoch() * 1000, 'skipped' FROM `bookings` WHERE `status` = 'cancelled' AND `cancelled_by` = 'venue';
