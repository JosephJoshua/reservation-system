ALTER TABLE `students` ADD `bind_code` text;--> statement-breakpoint
ALTER TABLE `students` ADD `bind_code_expires_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `students_bind_code_unique` ON `students` (`bind_code`);--> statement-breakpoint
CREATE INDEX `students_phone` ON `students` (`phone`);