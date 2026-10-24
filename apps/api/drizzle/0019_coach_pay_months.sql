CREATE TABLE `coach_pay_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`kind` text NOT NULL,
	`unit` text NOT NULL,
	`coach_id` integer NOT NULL,
	`lesson_type_id` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`rate` integer NOT NULL,
	`lessons` integer NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`month`) REFERENCES `coach_pay_months`(`month`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`coach_id`) REFERENCES `coaches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lesson_type_id`) REFERENCES `lesson_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `coach_pay_entries_month` ON `coach_pay_entries` (`month`);--> statement-breakpoint
CREATE INDEX `coach_pay_entries_unit` ON `coach_pay_entries` (`unit`);--> statement-breakpoint
CREATE TABLE `coach_pay_months` (
	`month` text PRIMARY KEY NOT NULL,
	`rules` text NOT NULL,
	`total` integer NOT NULL,
	`confirmed_at` integer NOT NULL,
	`staff_id` integer NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
