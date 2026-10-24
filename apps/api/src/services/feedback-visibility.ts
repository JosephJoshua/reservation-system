// When the student sees a lesson's 课后点评. Its own module so the feedback service and student
// messages both use it without importing each other.
import { and, eq, isNull } from 'drizzle-orm'
import { bookings, lessonFeedback } from '../db/schema'

/**
 * Feedback the student may see: not taken down, on a lesson still on and marked attended. For
 * queries that join bookings to lesson_feedback.
 */
export const visible = and(
  isNull(lessonFeedback.hiddenAt),
  eq(bookings.status, 'confirmed'),
  eq(bookings.attendance, 'attended'),
)

/** The same rule for a feedback row and booking already loaded. */
export function isVisible(
  feedback: Pick<typeof lessonFeedback.$inferSelect, 'hiddenAt'>,
  booking: Pick<typeof bookings.$inferSelect, 'status' | 'attendance'>,
) {
  return (
    feedback.hiddenAt === null &&
    booking.status === 'confirmed' &&
    booking.attendance === 'attended'
  )
}
