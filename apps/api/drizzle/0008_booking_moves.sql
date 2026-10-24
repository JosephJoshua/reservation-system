CREATE TABLE `booking_moves` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`booking_id` integer NOT NULL,
	`by` text NOT NULL,
	`from_coach_id` integer NOT NULL,
	`from_starts_at` integer NOT NULL,
	`from_ends_at` integer NOT NULL,
	`to_coach_id` integer NOT NULL,
	`to_starts_at` integer NOT NULL,
	`to_ends_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `booking_moves_booking` ON `booking_moves` (`booking_id`);--> statement-breakpoint
ALTER TABLE `bookings` ADD `coach_told_coach_id` integer;--> statement-breakpoint
ALTER TABLE `bookings` ADD `coach_told_starts_at` integer;--> statement-breakpoint
ALTER TABLE `bookings` ADD `coach_told_ends_at` integer;--> statement-breakpoint
UPDATE `bookings` SET `coach_told_coach_id` = (SELECT `coach_id` FROM `slots` WHERE `slots`.`id` = `bookings`.`slot_id`), `coach_told_starts_at` = `starts_at`, `coach_told_ends_at` = `ends_at` WHERE `coach_told_booked_at` IS NOT NULL;
--> statement-breakpoint
UPDATE `student_notices` SET `data` = json_set(`data`, '$.remindedFor', (SELECT cast(`starts_at` AS text) FROM `bookings` WHERE `bookings`.`id` = `student_notices`.`booking_id`)) WHERE `kind` = 'reminder' AND `done_at` IS NOT NULL;
