CREATE TABLE `schedule_exceptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`coach_id` integer,
	`kind` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`by_staff_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`coach_id`) REFERENCES `coaches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`by_staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `schedule_exceptions_coach_time` ON `schedule_exceptions` (`coach_id`,`ends_at`);--> statement-breakpoint
-- Days off become whole-day 请假, venue midnight to midnight (China Standard Time, UTC+8).
INSERT INTO `schedule_exceptions` (`coach_id`, `kind`, `starts_at`, `ends_at`)
SELECT `coach_id`, 'off',
	CAST(strftime('%s', `date`) AS integer) * 1000 - 28800000,
	CAST(strftime('%s', `date`, '+1 day') AS integer) * 1000 - 28800000
FROM `coach_days_off`;--> statement-breakpoint
-- A private slot the venue opened by hand stays bookable as 加班 for its time.
INSERT INTO `schedule_exceptions` (`coach_id`, `kind`, `starts_at`, `ends_at`)
SELECT `coach_id`, 'extra', `starts_at`, `ends_at` FROM `slots`
WHERE `lesson_type_id` IS NULL AND `source` = 'manual' AND `open` = 1;--> statement-breakpoint
-- A free private slot a person closed stays closed as 请假 for its time.
INSERT INTO `schedule_exceptions` (`coach_id`, `kind`, `starts_at`, `ends_at`)
SELECT `coach_id`, 'off', `starts_at`, `ends_at` FROM `slots`
WHERE `lesson_type_id` IS NULL AND `open` = 0 AND `closed_by_sync` = 0
	AND `ends_at` > unixepoch() * 1000
	AND NOT EXISTS (
		SELECT 1 FROM `bookings` WHERE `bookings`.`slot_id` = `slots`.`id`
			AND `bookings`.`status` IN ('pending_payment', 'confirmed')
	);--> statement-breakpoint
-- Private slots nobody ever booked are gone: bookable times now come from 排班.
DELETE FROM `slots`
WHERE `lesson_type_id` IS NULL
	AND NOT EXISTS (SELECT 1 FROM `bookings` WHERE `bookings`.`slot_id` = `slots`.`id`);--> statement-breakpoint
DROP TABLE `coach_days_off`;--> statement-breakpoint
-- Hours saved so far apply from the start, so past days keep them in reports.
ALTER TABLE `coach_hours` ADD `from_date` text DEFAULT '2000-01-01' NOT NULL;--> statement-breakpoint
ALTER TABLE `coach_hours` ADD `to_date` text;--> statement-breakpoint
ALTER TABLE `coach_hours` DROP COLUMN `lesson_minutes`;--> statement-breakpoint
ALTER TABLE `slots` DROP COLUMN `source`;--> statement-breakpoint
ALTER TABLE `slots` DROP COLUMN `closed_by_sync`;
