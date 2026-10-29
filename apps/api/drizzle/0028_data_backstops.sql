CREATE UNIQUE INDEX `coach_pay_entries_lesson` ON `coach_pay_entries` (`month`,`unit`) WHERE kind = 'lesson';--> statement-breakpoint
CREATE UNIQUE INDEX `packages_order` ON `packages` (`order_id`);--> statement-breakpoint
-- A package never goes below zero lessons. Triggers rather than a CHECK, which would need a table
-- rebuild under foreign keys; an update only fails when it lowers a count that ends below zero.
CREATE TRIGGER `packages_lessons_not_negative_insert` BEFORE INSERT ON `packages`
WHEN NEW.lessons_remaining < 0
BEGIN SELECT RAISE(ABORT, 'packages.lessons_remaining below 0'); END;--> statement-breakpoint
CREATE TRIGGER `packages_lessons_not_negative_update` BEFORE UPDATE OF `lessons_remaining` ON `packages`
WHEN NEW.lessons_remaining < 0 AND NEW.lessons_remaining < OLD.lessons_remaining
BEGIN SELECT RAISE(ABORT, 'packages.lessons_remaining below 0'); END;
