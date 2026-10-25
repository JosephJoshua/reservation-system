import { describe, expect, it } from 'vitest'
import { attendanceError, feedbackError } from './availability'

describe('attendanceError', () => {
  const booking = {
    status: 'confirmed',
    startsAt: new Date('2026-10-25T02:00:00Z'),
    endsAt: new Date('2026-10-25T03:00:00Z'),
    attendance: null,
  }

  it('waits for the lesson to start, except for front desk arrivals 30 minutes early', () => {
    const early = new Date('2026-10-25T01:30:00Z')
    expect(attendanceError(booking, new Date('2026-10-25T01:29:00Z'), 'admin', 'attended')).toBe(
      'not_started',
    )
    expect(attendanceError(booking, early, 'admin', 'attended')).toBeNull()
    expect(attendanceError(booking, early, 'student', 'attended')).toBeNull()
    expect(attendanceError(booking, early, 'admin', null)).toBeNull()
    expect(attendanceError(booking, early, 'admin', 'no_show')).toBe('not_started')
    expect(attendanceError(booking, early, 'coach', 'attended')).toBe('not_started')
    expect(attendanceError(booking, early, 'coach', null)).toBe('not_started')
    expect(
      attendanceError(booking, new Date('2026-10-25T02:00:00Z'), 'coach', 'no_show'),
    ).toBeNull()
  })

  it('gives the coach a week after the lesson, the admin forever', () => {
    const later = new Date('2026-11-02T03:00:00Z')
    expect(attendanceError(booking, later, 'coach', 'attended')).toBe('too_late')
    expect(attendanceError(booking, later, 'admin', 'attended')).toBeNull()
  })

  it('lets a student check in until the lesson ends, unless marked absent', () => {
    expect(
      attendanceError(booking, new Date('2026-10-25T02:59:00Z'), 'student', 'attended'),
    ).toBeNull()
    expect(attendanceError(booking, new Date('2026-10-25T03:00:00Z'), 'student', 'attended')).toBe(
      'too_late',
    )
    expect(
      attendanceError(
        { ...booking, attendance: 'no_show' },
        new Date('2026-10-25T02:30:00Z'),
        'student',
        'attended',
      ),
    ).toBe('marked')
    expect(
      attendanceError(
        { ...booking, attendance: 'no_show' },
        new Date('2026-10-25T02:30:00Z'),
        'coach',
        'attended',
      ),
    ).toBeNull()
  })

  it('only applies to confirmed bookings', () => {
    expect(
      attendanceError(
        { ...booking, status: 'cancelled' },
        new Date('2026-10-25T02:30:00Z'),
        'admin',
        'attended',
      ),
    ).toBe('not_confirmed')
  })
})

describe('feedbackError', () => {
  const booking = {
    status: 'confirmed',
    attendance: 'attended' as const,
    attendanceAt: new Date('2026-10-25T03:05:00Z'),
    endsAt: new Date('2026-10-25T03:00:00Z'),
  }

  it('needs a lesson the student came to', () => {
    const now = new Date('2026-10-25T03:30:00Z')
    expect(feedbackError(booking, now)).toBeNull()
    expect(feedbackError({ ...booking, attendance: null }, now)).toBe('not_attended')
    expect(feedbackError({ ...booking, attendance: 'no_show' }, now)).toBe('not_attended')
    expect(feedbackError({ ...booking, status: 'cancelled' }, now)).toBe('not_attended')
  })

  it('gives the coach a week after the lesson, or after a later attendance mark', () => {
    const marked = { ...booking, attendanceAt: null }
    expect(feedbackError(marked, new Date('2026-11-01T03:00:00Z'))).toBeNull()
    expect(feedbackError(marked, new Date('2026-11-01T03:00:01Z'))).toBe('too_late')
    // Marked by the venue ten days on: the coach still has a week from then.
    const late = { ...booking, attendanceAt: new Date('2026-11-04T03:00:00Z') }
    expect(feedbackError(late, new Date('2026-11-11T03:00:00Z'))).toBeNull()
    expect(feedbackError(late, new Date('2026-11-11T03:00:01Z'))).toBe('too_late')
  })
})
