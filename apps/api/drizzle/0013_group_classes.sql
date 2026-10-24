DROP INDEX `bookings_one_live_per_slot`;--> statement-breakpoint
ALTER TABLE `bookings` ADD `seat` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_one_live_per_seat` ON `bookings` (`slot_id`,`seat`) WHERE status in ('pending_payment', 'confirmed');--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_one_live_per_student` ON `bookings` (`slot_id`,`student_id`) WHERE status in ('pending_payment', 'confirmed');--> statement-breakpoint
ALTER TABLE `lesson_types` ADD `capacity` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `lesson_types` ADD `min_students` integer;--> statement-breakpoint
ALTER TABLE `slots` ADD `lesson_type_id` integer REFERENCES lesson_types(id);--> statement-breakpoint
ALTER TABLE `slots` ADD `capacity` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `slots` ADD `cancelled_at` integer;--> statement-breakpoint
ALTER TABLE `slots` ADD `cancel_reason` text;--> statement-breakpoint
ALTER TABLE `slots` ADD `min_checked_at` integer;--> statement-breakpoint
ALTER TABLE `slots` ADD `coach_told_booked_at` integer;--> statement-breakpoint
ALTER TABLE `slots` ADD `coach_told_cancelled_at` integer;