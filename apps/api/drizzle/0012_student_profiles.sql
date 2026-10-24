CREATE TABLE `student_profiles` (
	`student_id` integer PRIMARY KEY NOT NULL,
	`level` text,
	`grip` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
