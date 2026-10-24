CREATE TABLE `category_pay_rates` (
	`category_id` integer NOT NULL,
	`lesson_type_id` integer NOT NULL,
	`rate` integer NOT NULL,
	PRIMARY KEY(`category_id`, `lesson_type_id`),
	FOREIGN KEY (`category_id`) REFERENCES `coach_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lesson_type_id`) REFERENCES `lesson_types`(`id`) ON UPDATE no action ON DELETE no action
);
