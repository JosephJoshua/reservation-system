import { describe, expect, it } from 'vitest'
import {
  attendanceError,
  lessonsFromHours,
  venueDates,
  type WeeklyHours,
  weeklyHoursError,
} from './availability'
import { venueInstant } from './time'

const hours = (weekday: number, from: string, to: string, lessonMinutes = 60): WeeklyHours => {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  return { weekday, startMinute: m(from), endMinute: m(to), lessonMinutes }
}

describe('weeklyHoursError', () => {
  it('accepts separate windows on one day', () => {
    expect(weeklyHoursError([hours(1, '09:00', '12:00'), hours(1, '12:00', '15:00')])).toBeNull()
  })

  it('rejects overlapping windows on one day', () => {
    expect(weeklyHoursError([hours(1, '09:00', '12:00'), hours(1, '11:00', '15:00')])).toBe(
      '同一天的时间段不能重叠',
    )
  })

  it('allows the same window on different days', () => {
    expect(weeklyHoursError([hours(1, '09:00', '12:00'), hours(2, '09:00', '12:00')])).toBeNull()
  })

  it('rejects an empty or too short window', () => {
    expect(weeklyHoursError([hours(1, '12:00', '12:00')])).toBe('结束时间需晚于开始时间')
    expect(weeklyHoursError([hours(1, '12:00', '12:30')])).toBe('时间段短于一节课')
  })
})

describe('venueDates', () => {
  it('counts venue days, not UTC days', () => {
    // 23:30 on the 23rd in UTC is already the 24th in China.
    expect(venueDates(new Date('2026-10-23T16:30:00Z'), 2)).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ])
  })
})

describe('lessonsFromHours', () => {
  // 2026-10-26 is a Monday.
  const monday = hours(1, '14:00', '17:30')

  it('cuts a window into whole lessons at venue time', () => {
    const lessons = lessonsFromHours([monday], ['2026-10-25', '2026-10-26'], new Set())
    expect(lessons.map((l) => l.startsAt.toISOString())).toEqual([
      venueInstant('2026-10-26', 14 * 60).toISOString(),
      venueInstant('2026-10-26', 15 * 60).toISOString(),
      venueInstant('2026-10-26', 16 * 60).toISOString(),
    ])
    expect(lessons[2]?.endsAt.toISOString()).toBe('2026-10-26T09:00:00.000Z')
  })

  it('skips days off', () => {
    expect(lessonsFromHours([monday], ['2026-10-26'], new Set(['2026-10-26']))).toEqual([])
  })

  it('sorts lessons from several windows', () => {
    const lessons = lessonsFromHours(
      [hours(1, '18:00', '19:00'), hours(1, '09:00', '10:30', 90)],
      ['2026-10-26'],
      new Set(),
    )
    expect(lessons.map((l) => l.startsAt.getTime())).toEqual([
      venueInstant('2026-10-26', 9 * 60).getTime(),
      venueInstant('2026-10-26', 18 * 60).getTime(),
    ])
  })
})

describe('attendanceError', () => {
  const booking = {
    status: 'confirmed',
    startsAt: new Date('2026-10-25T02:00:00Z'),
    endsAt: new Date('2026-10-25T03:00:00Z'),
  }

  it('waits for the lesson to start', () => {
    expect(attendanceError(booking, new Date('2026-10-25T01:59:00Z'), 'coach')).toBe('not_started')
    expect(attendanceError(booking, new Date('2026-10-25T02:00:00Z'), 'coach')).toBeNull()
  })

  it('gives the coach a week after the lesson, the admin forever', () => {
    const later = new Date('2026-11-02T03:00:00Z')
    expect(attendanceError(booking, later, 'coach')).toBe('too_late')
    expect(attendanceError(booking, later, 'admin')).toBeNull()
  })

  it('only applies to confirmed bookings', () => {
    expect(
      attendanceError(
        { ...booking, status: 'cancelled' },
        new Date('2026-10-25T02:30:00Z'),
        'admin',
      ),
    ).toBe('not_confirmed')
  })
})
