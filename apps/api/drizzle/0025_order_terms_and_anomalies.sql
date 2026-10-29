ALTER TABLE `orders` ADD `package_terms` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `anomaly` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `anomaly_amount` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `anomaly_handled_at` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `anomaly_note` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `abnormal` integer DEFAULT false NOT NULL;