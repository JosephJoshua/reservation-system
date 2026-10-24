ALTER TABLE `bookings` ADD `attendance_by` text;--> statement-breakpoint
ALTER TABLE `bookings` ADD `attendance_staff_id` integer REFERENCES staff(id);