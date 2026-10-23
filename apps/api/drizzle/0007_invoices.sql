CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` integer NOT NULL,
	`order_id` integer NOT NULL,
	`status` text NOT NULL,
	`title_kind` text NOT NULL,
	`title` text NOT NULL,
	`tax_number` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`amount` integer NOT NULL,
	`reject_reason` text,
	`pdf_file` text,
	`issued_at` integer,
	`handled_by_staff_id` integer,
	`refunds_seen` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handled_by_staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_one_live_per_order` ON `invoices` (`order_id`) WHERE status in ('requested', 'issued');--> statement-breakpoint
CREATE INDEX `invoices_status` ON `invoices` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `invoices_student` ON `invoices` (`student_id`);--> statement-breakpoint
ALTER TABLE `students` ADD `invoice_title` text;