CREATE TABLE `category_prices` (
	`category_id` integer NOT NULL,
	`lesson_type_id` integer NOT NULL,
	`price` integer NOT NULL,
	PRIMARY KEY(`category_id`, `lesson_type_id`),
	FOREIGN KEY (`category_id`) REFERENCES `coach_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lesson_type_id`) REFERENCES `lesson_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `coach_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `coaches` ADD `category_id` integer REFERENCES coach_categories(id);--> statement-breakpoint
ALTER TABLE `coaches` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `coaches` ADD `profile` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `coaches` SET `profile` = '<p>' || replace(replace(replace(replace(`bio`, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), char(10), '<br>') || '</p>' WHERE `bio` != '';--> statement-breakpoint
INSERT INTO `coach_categories` (`id`, `name`, `sort`) SELECT `id`, `name`, `sort` FROM `coaches` WHERE `id` IN (SELECT `coach_id` FROM `coach_lesson_types` WHERE `price` IS NOT NULL);--> statement-breakpoint
INSERT INTO `category_prices` (`category_id`, `lesson_type_id`, `price`) SELECT `coach_id`, `lesson_type_id`, `price` FROM `coach_lesson_types` WHERE `price` IS NOT NULL;--> statement-breakpoint
UPDATE `coaches` SET `category_id` = `id` WHERE `id` IN (SELECT `id` FROM `coach_categories`);--> statement-breakpoint
ALTER TABLE `coach_lesson_types` DROP COLUMN `price`;--> statement-breakpoint
ALTER TABLE `coaches` DROP COLUMN `bio`;