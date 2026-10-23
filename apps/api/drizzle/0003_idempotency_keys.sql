CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`status` integer,
	`body` text,
	`content_type` text,
	`created_at` integer NOT NULL
);
