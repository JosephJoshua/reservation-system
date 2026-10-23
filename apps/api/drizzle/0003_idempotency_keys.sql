CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`body_hash` text NOT NULL,
	`status` integer,
	`body` text,
	`content_type` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_created` ON `idempotency_keys` (`created_at`);