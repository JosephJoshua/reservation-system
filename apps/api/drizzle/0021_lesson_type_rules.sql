ALTER TABLE `bookings` ADD `terms` text;--> statement-breakpoint
ALTER TABLE `lesson_types` ADD `rules` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Lessons already booked keep the venue's cancel and move rules as they stand now. A value the app
-- would not accept falls back to the shipped default.
UPDATE `bookings` SET `terms` = (
  SELECT json_object(
    'cancelDeadlineHours',
      CASE WHEN typeof(h) = 'integer' AND h BETWEEN 0 AND 336 THEN h ELSE 24 END,
    'lateCancel',
      CASE
        WHEN json_extract(l, '$.kind') = 'forfeit' THEN json('{"kind":"forfeit"}')
        WHEN json_extract(l, '$.kind') = 'partial'
          AND typeof(json_extract(l, '$.percent')) = 'integer'
          AND json_extract(l, '$.percent') BETWEEN 0 AND 100
          THEN json_object('kind', 'partial', 'percent', json_extract(l, '$.percent'))
        ELSE json('{"kind":"forfeit"}')
      END,
    'studentMoves',
      CASE WHEN typeof(m) = 'integer' AND m BETWEEN 0 AND 5 THEN m ELSE 1 END
  )
  FROM (
    SELECT
      (SELECT json_extract(`data`, '$.booking.cancelDeadlineHours') FROM `settings` WHERE `id` = 1) AS h,
      (SELECT json_extract(`data`, '$.booking.lateCancel') FROM `settings` WHERE `id` = 1) AS l,
      (SELECT json_extract(`data`, '$.booking.studentMoves') FROM `settings` WHERE `id` = 1) AS m
  )
);
