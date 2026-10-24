ALTER TABLE `student_profiles` ADD `updated_by_coach` integer REFERENCES coaches(id);--> statement-breakpoint
ALTER TABLE `student_profiles` ADD `updated_by_staff` integer REFERENCES staff(id);