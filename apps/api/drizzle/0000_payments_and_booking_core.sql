CREATE TABLE `banners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`image_url` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`link_kind` text DEFAULT 'none' NOT NULL,
	`link_id` integer,
	`starts_at` integer,
	`ends_at` integer,
	`active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slot_id` integer NOT NULL,
	`student_id` integer NOT NULL,
	`lesson_type_id` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text NOT NULL,
	`paid_with` text NOT NULL,
	`price` integer NOT NULL,
	`package_id` integer,
	`cancelled_at` integer,
	`cancelled_by` text,
	`cancel_reason` text,
	`late` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lesson_type_id`) REFERENCES `lesson_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_one_live_per_slot` ON `bookings` (`slot_id`) WHERE status in ('pending_payment', 'confirmed');--> statement-breakpoint
CREATE INDEX `bookings_student_time` ON `bookings` (`student_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `coach_lesson_types` (
	`coach_id` integer NOT NULL,
	`lesson_type_id` integer NOT NULL,
	`price` integer,
	PRIMARY KEY(`coach_id`, `lesson_type_id`),
	FOREIGN KEY (`coach_id`) REFERENCES `coaches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lesson_type_id`) REFERENCES `lesson_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `coaches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`avatar_url` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lesson_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`duration_minutes` integer NOT NULL,
	`price` integer NOT NULL,
	`is_trial` integer DEFAULT false NOT NULL,
	`admin_only` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sale_percent` integer,
	`sale_starts_at` integer,
	`sale_ends_at` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`out_trade_no` text NOT NULL,
	`student_id` integer NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`amount` integer NOT NULL,
	`provider` text NOT NULL,
	`offline_method` text,
	`status` text NOT NULL,
	`prepay_id` text,
	`transaction_id` text,
	`booking_id` integer,
	`product_id` integer,
	`expires_at` integer,
	`paid_at` integer,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_out_trade_no_unique` ON `orders` (`out_trade_no`);--> statement-breakpoint
CREATE INDEX `orders_status_expiry` ON `orders` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `package_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`package_id` integer NOT NULL,
	`delta` integer NOT NULL,
	`kind` text NOT NULL,
	`booking_id` integer,
	`note` text DEFAULT '' NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `package_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`lesson_type_id` integer NOT NULL,
	`coach_ids` text DEFAULT '[]' NOT NULL,
	`lesson_count` integer NOT NULL,
	`price` integer NOT NULL,
	`validity_days` integer NOT NULL,
	`on_sale` integer DEFAULT true NOT NULL,
	`sale_price` integer,
	`sale_starts_at` integer,
	`sale_ends_at` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`lesson_type_id`) REFERENCES `lesson_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`name` text NOT NULL,
	`lesson_type_id` integer NOT NULL,
	`coach_ids` text NOT NULL,
	`lessons_purchased` integer NOT NULL,
	`lessons_remaining` integer NOT NULL,
	`price_paid` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`order_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `package_products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lesson_type_id`) REFERENCES `lesson_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `packages_student` ON `packages` (`student_id`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`out_refund_no` text NOT NULL,
	`order_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`booking_id` integer,
	`package_id` integer,
	`provider_refund_id` text,
	`failure` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_out_refund_no_unique` ON `refunds` (`out_refund_no`);--> statement-breakpoint
CREATE INDEX `refunds_status` ON `refunds` (`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`student_id` integer,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`coach_id` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`open` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`coach_id`) REFERENCES `coaches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `slots_coach_time` ON `slots` (`coach_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `students` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`openid` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`tester` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `students_openid_unique` ON `students` (`openid`);