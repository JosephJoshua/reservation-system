CREATE INDEX `action_log_student` ON `action_log` (`student_id`);--> statement-breakpoint
CREATE INDEX `bookings_time` ON `bookings` (`starts_at`);--> statement-breakpoint
CREATE INDEX `bookings_slot` ON `bookings` (`slot_id`);--> statement-breakpoint
CREATE INDEX `bookings_package` ON `bookings` (`package_id`);--> statement-breakpoint
CREATE INDEX `orders_paid` ON `orders` (`status`,`paid_at`);--> statement-breakpoint
CREATE INDEX `orders_booking` ON `orders` (`booking_id`);--> statement-breakpoint
CREATE INDEX `orders_student` ON `orders` (`student_id`);--> statement-breakpoint
CREATE INDEX `package_ledger_package` ON `package_ledger` (`package_id`);--> statement-breakpoint
CREATE INDEX `package_ledger_booking` ON `package_ledger` (`booking_id`);--> statement-breakpoint
CREATE INDEX `refunds_order` ON `refunds` (`order_id`);--> statement-breakpoint
CREATE INDEX `slots_time` ON `slots` (`starts_at`);