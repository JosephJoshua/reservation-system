CREATE TABLE `action_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`staff_id` integer NOT NULL,
	`action` text NOT NULL,
	`summary` text NOT NULL,
	`amount` integer,
	`student_id` integer,
	`target_kind` text,
	`target_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `action_log_time` ON `action_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `action_log_staff` ON `action_log` (`staff_id`);--> statement-breakpoint
CREATE TABLE `staff` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_username_unique` ON `staff` (`username`);--> statement-breakpoint
ALTER TABLE `bookings` ADD `booked_by_staff_id` integer REFERENCES staff(id);--> statement-breakpoint
ALTER TABLE `sessions` ADD `staff_id` integer REFERENCES staff(id);--> statement-breakpoint
DELETE FROM `sessions` WHERE `role` = 'admin';