CREATE TABLE `package_notices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`package_id` integer NOT NULL,
	`kind` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`retry_at` integer,
	`done_at` integer,
	`result` text,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_notices_expiring` ON `package_notices` (`package_id`,`expires_at`) WHERE kind = 'expiring';--> statement-breakpoint
CREATE UNIQUE INDEX `package_notices_used_up` ON `package_notices` (`package_id`) WHERE kind = 'used_up';--> statement-breakpoint
CREATE INDEX `package_notices_pending` ON `package_notices` (`done_at`);--> statement-breakpoint
-- Packages used up before these messages existed are not announced.
INSERT INTO `package_notices` (`package_id`, `kind`, `expires_at`, `done_at`, `result`) SELECT `id`, 'used_up', `expires_at`, unixepoch() * 1000, 'skipped' FROM `packages` WHERE `lessons_remaining` <= 0;
