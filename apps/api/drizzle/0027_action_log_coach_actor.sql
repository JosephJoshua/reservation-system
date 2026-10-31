PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_action_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`staff_id` integer,
	`coach_id` integer,
	`action` text NOT NULL,
	`summary` text NOT NULL,
	`amount` integer,
	`student_id` integer,
	`target_kind` text,
	`target_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`coach_id`) REFERENCES `coaches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "action_log_actor" CHECK((`staff_id` is null) <> (`coach_id` is null))
);
--> statement-breakpoint
-- Every entry so far was made by a staff member.
INSERT INTO `__new_action_log`("id", "staff_id", "coach_id", "action", "summary", "amount", "student_id", "target_kind", "target_id", "created_at") SELECT "id", "staff_id", NULL, "action", "summary", "amount", "student_id", "target_kind", "target_id", "created_at" FROM `action_log`;--> statement-breakpoint
-- Keeps the id counter, so ids of deleted entries are never handed out again.
DELETE FROM `sqlite_sequence` WHERE `name` = '__new_action_log';--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT '__new_action_log', `seq` FROM `sqlite_sequence` WHERE `name` = 'action_log';--> statement-breakpoint
DROP TABLE `action_log`;--> statement-breakpoint
ALTER TABLE `__new_action_log` RENAME TO `action_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `action_log_time` ON `action_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `action_log_staff` ON `action_log` (`staff_id`);--> statement-breakpoint
CREATE INDEX `action_log_student` ON `action_log` (`student_id`);--> statement-breakpoint
CREATE INDEX `action_log_coach` ON `action_log` (`coach_id`);