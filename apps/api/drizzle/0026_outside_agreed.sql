ALTER TABLE `bookings` ADD `outside_agreed` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Lessons yet to come that the venue placed where they are (booked at the desk, or last moved by the
-- venue) may have been agreed outside 排班. They are marked 2, to be checked against 排班 when the
-- server starts (settleOutsideAgreed), which sets 1 where the lesson is outside 排班 and 0 otherwise.
UPDATE `bookings` SET `outside_agreed` = 2
WHERE `status` IN ('pending_payment', 'confirmed')
	AND `starts_at` > unixepoch() * 1000
	AND `slot_id` IN (SELECT `id` FROM `slots` WHERE `lesson_type_id` IS NULL)
	AND (
		(SELECT `by` FROM `booking_moves` WHERE `booking_moves`.`booking_id` = `bookings`.`id` ORDER BY `id` DESC LIMIT 1) = 'venue'
		OR (`booked_by_staff_id` IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM `booking_moves` WHERE `booking_moves`.`booking_id` = `bookings`.`id`))
	);
