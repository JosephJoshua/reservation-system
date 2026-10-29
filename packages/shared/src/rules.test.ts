import { describe, expect, it } from 'vitest'
import {
  bookingTerms,
  bookingWindowError,
  cancelDeadline,
  cancellationOutcome,
  endsSameVenueDay,
  freeCancelDeadline,
  peakOverlap,
  rulesFor,
  samePackageTerms,
  sameTerms,
  studentMoveError,
  tablesFor,
  tablesFree,
  validityEnd,
} from './rules'
import { defaultSettings, ruleNames, ruleText, type VenueSettings } from './settings'

const rules = defaultSettings.booking
const at = (iso: string) => new Date(iso)

describe('bookingWindowError', () => {
  const now = at('2026-10-23T02:00:00Z') // 10:00 at the venue

  it('accepts a lesson within the window', () => {
    expect(bookingWindowError(at('2026-10-24T02:00:00Z'), now, rules)).toBeNull()
  })

  it('rejects lessons that started or start too soon', () => {
    expect(bookingWindowError(now, now, rules)).toBe('started')
    expect(bookingWindowError(at('2026-10-23T03:59:00Z'), now, rules)).toBe('too_soon')
    expect(bookingWindowError(at('2026-10-23T04:00:00Z'), now, rules)).toBeNull()
  })

  it('allows the whole venue day at the end of the window', () => {
    // 14 days from 2026-10-23 is 2026-11-06; its last minute at the venue is 15:59 UTC.
    expect(bookingWindowError(at('2026-11-06T15:59:00Z'), now, rules)).toBeNull()
    expect(bookingWindowError(at('2026-11-06T16:00:00Z'), now, rules)).toBe('too_far')
  })
})

describe('cancellationOutcome', () => {
  const startsAt = at('2026-10-25T02:00:00Z')
  const endsAt = at('2026-10-25T03:00:00Z')
  const base = { startsAt, endsAt, amountPaid: 20000, rules }

  it('refunds everything before the deadline', () => {
    const now = at('2026-10-24T01:59:00Z')
    expect(
      cancellationOutcome({ ...base, now, cancelledBy: 'student', paidWith: 'order' }),
    ).toEqual({ late: false, refund: 20000, returnLesson: false })
    expect(
      cancellationOutcome({ ...base, now, cancelledBy: 'student', paidWith: 'package' }),
    ).toEqual({ late: false, refund: 0, returnLesson: true })
  })

  it('forfeits after the deadline by default', () => {
    const now = at('2026-10-24T02:00:01Z')
    expect(
      cancellationOutcome({ ...base, now, cancelledBy: 'student', paidWith: 'order' }),
    ).toEqual({ late: true, refund: 0, returnLesson: false })
    expect(
      cancellationOutcome({ ...base, now, cancelledBy: 'student', paidWith: 'package' }),
    ).toEqual({ late: true, refund: 0, returnLesson: false })
  })

  it('applies a partial late refund, rounding down', () => {
    const partial: VenueSettings['booking'] = {
      ...rules,
      lateCancel: { kind: 'partial', percent: 33 },
    }
    const now = at('2026-10-24T12:00:00Z')
    const input = { ...base, rules: partial, now, cancelledBy: 'student' as const }
    expect(cancellationOutcome({ ...input, paidWith: 'order', amountPaid: 10001 })).toEqual({
      late: true,
      refund: 3300,
      returnLesson: false,
    })
    const full = { ...rules, lateCancel: { kind: 'partial' as const, percent: 100 } }
    expect(cancellationOutcome({ ...input, rules: full, paidWith: 'package' })).toEqual({
      late: true,
      refund: 0,
      returnLesson: true,
    })
  })

  it('stops students cancelling once the lesson started', () => {
    expect(
      cancellationOutcome({ ...base, now: startsAt, cancelledBy: 'student', paidWith: 'order' }),
    ).toBe('started')
  })

  it('always gives everything back when the venue cancels, until the lesson ends', () => {
    const now = at('2026-10-25T02:30:00Z')
    expect(cancellationOutcome({ ...base, now, cancelledBy: 'venue', paidWith: 'order' })).toEqual({
      late: false,
      refund: 20000,
      returnLesson: false,
    })
    expect(
      cancellationOutcome({ ...base, now: endsAt, cancelledBy: 'venue', paidWith: 'order' }),
    ).toBe('ended')
  })
})

describe('cancelDeadline', () => {
  it('is the configured hours before the start', () => {
    expect(cancelDeadline(at('2026-10-25T02:00:00Z'), rules).toISOString()).toBe(
      '2026-10-24T02:00:00.000Z',
    )
  })
})

describe('studentMoveError', () => {
  const startsAt = at('2026-10-25T02:00:00Z')
  const deadline = cancelDeadline(startsAt, rules)
  const base = { status: 'confirmed' as const, deadline, movesUsed: 0, rules }

  it('allows a confirmed lesson until the free-cancel deadline', () => {
    expect(studentMoveError({ ...base, now: at('2026-10-24T02:00:00Z') })).toBeNull()
  })

  it('refuses after the deadline', () => {
    expect(studentMoveError({ ...base, now: at('2026-10-24T02:00:00.001Z') })).toBe('deadline')
    expect(studentMoveError({ ...base, deadline: startsAt, now: startsAt })).toBeNull()
    expect(studentMoveError({ ...base, deadline: startsAt, now: at('2026-10-25T02:00:01Z') })).toBe(
      'deadline',
    )
  })

  it('refuses unpaid, cancelled and expired bookings', () => {
    const now = at('2026-10-23T02:00:00Z')
    for (const status of ['pending_payment', 'cancelled', 'expired'] as const) {
      expect(studentMoveError({ ...base, status, now })).toBe('not_confirmed')
    }
  })

  it('counts moves against the allowance, and 0 turns moving off', () => {
    const now = at('2026-10-23T02:00:00Z')
    expect(studentMoveError({ ...base, movesUsed: 1, now })).toBe('no_moves_left')
    const two = { ...rules, studentMoves: 2 }
    expect(studentMoveError({ ...base, movesUsed: 1, rules: two, now })).toBeNull()
    const off = { ...rules, studentMoves: 0 }
    expect(studentMoveError({ ...base, rules: off, now })).toBe('no_moves_left')
  })
})

describe('freeCancelDeadline', () => {
  const startsAt = at('2026-10-25T02:00:00Z')
  const usual = at('2026-10-24T02:00:00Z')

  it('is the usual deadline unless the venue moved the lesson after it', () => {
    expect(freeCancelDeadline(startsAt, rules)).toEqual(usual)
    expect(
      freeCancelDeadline(startsAt, rules, { by: 'venue', at: at('2026-10-23T02:00:00Z') }),
    ).toEqual(usual)
    expect(
      freeCancelDeadline(startsAt, rules, { by: 'coach', at: at('2026-10-24T05:00:00Z') }),
    ).toEqual(startsAt)
    // A time the student picked themselves keeps the usual deadline.
    expect(
      freeCancelDeadline(startsAt, rules, { by: 'student', at: at('2026-10-24T05:00:00Z') }),
    ).toEqual(usual)
  })

  it('lets cancellationOutcome treat a cancel before it as free', () => {
    const outcome = cancellationOutcome({
      startsAt,
      endsAt: at('2026-10-25T03:00:00Z'),
      now: at('2026-10-25T01:00:00Z'),
      cancelledBy: 'student',
      paidWith: 'order',
      amountPaid: 20000,
      rules,
      deadline: startsAt,
    })
    expect(outcome).toEqual({ late: false, refund: 20000, returnLesson: false })
  })
})

describe('endsSameVenueDay', () => {
  it('allows a lesson ending at 24:00 venue time and refuses one running past it', () => {
    // 23:00 to 24:00 at the venue is 15:00 to 16:00 UTC.
    expect(endsSameVenueDay(at('2026-10-25T15:00:00Z'), at('2026-10-25T16:00:00Z'))).toBe(true)
    expect(endsSameVenueDay(at('2026-10-25T15:30:00Z'), at('2026-10-25T16:30:00Z'))).toBe(false)
  })
})

describe('samePackageTerms', () => {
  const terms = { lessonTypeId: 1, coachIds: [3, 2], lessonCount: 10, validityDays: 90 }
  it('ignores coach order', () => {
    expect(samePackageTerms(terms, { ...terms, coachIds: [2, 3] })).toBe(true)
  })
  it('notices any change in what the package grants', () => {
    expect(samePackageTerms(terms, { ...terms, lessonCount: 5 })).toBe(false)
    expect(samePackageTerms(terms, { ...terms, validityDays: 7 })).toBe(false)
    expect(samePackageTerms(terms, { ...terms, lessonTypeId: 2 })).toBe(false)
    expect(samePackageTerms(terms, { ...terms, coachIds: [2] })).toBe(false)
    expect(samePackageTerms(terms, { ...terms, coachIds: [] })).toBe(false)
  })
})

describe('validityEnd', () => {
  it('runs to the end of the venue day', () => {
    // Bought 2026-10-23 23:30 at the venue; 30 days later is 2026-11-22, ending 16:00 UTC.
    expect(validityEnd(at('2026-10-23T15:30:00Z'), 30).toISOString()).toBe(
      '2026-11-22T16:00:00.000Z',
    )
  })
})

describe('peakOverlap', () => {
  const span = (from: string, to: string) => ({
    startsAt: at(`2026-10-25T${from}:00Z`),
    endsAt: at(`2026-10-25T${to}:00Z`),
  })
  const lesson = span('02:00', '03:00')

  it('counts lessons running together, not every lesson that overlaps', () => {
    // 02:00-02:30 and 02:30-03:00 never run together.
    expect(peakOverlap(lesson, [span('01:30', '02:30'), span('02:30', '03:30')])).toBe(1)
    expect(peakOverlap(lesson, [span('01:30', '02:31'), span('02:30', '03:30')])).toBe(2)
    expect(peakOverlap(lesson, [span('02:00', '03:00'), span('02:15', '02:45')])).toBe(2)
  })

  it('ignores lessons that only touch its ends', () => {
    expect(peakOverlap(lesson, [span('01:00', '02:00'), span('03:00', '04:00')])).toBe(0)
    expect(peakOverlap(lesson, [])).toBe(0)
  })

  it('only counts the part inside the lesson', () => {
    // Three lessons overlap each other before 02:00, but only one runs during the lesson.
    const before = [span('01:00', '02:00'), span('01:00', '02:00'), span('01:30', '02:10')]
    expect(peakOverlap(lesson, before)).toBe(1)
  })
})

describe('peakOverlap with group sessions', () => {
  it('adds up the tables each lesson uses', () => {
    const lesson = { startsAt: at('2026-10-25T02:00:00Z'), endsAt: at('2026-10-25T03:00:00Z') }
    expect(peakOverlap(lesson, [{ ...lesson, tables: 2 }, lesson])).toBe(3)
    expect(peakOverlap(lesson, [{ ...lesson, tables: 0 }])).toBe(0)
  })
})

describe('tablesFor', () => {
  it('takes one table per group of students, or one for the whole class', () => {
    expect(tablesFor(0, 2)).toBe(0)
    expect(tablesFor(1, null)).toBe(1)
    expect(tablesFor(6, null)).toBe(1)
    expect(tablesFor(1, 2)).toBe(1)
    expect(tablesFor(2, 2)).toBe(1)
    expect(tablesFor(3, 2)).toBe(2)
    expect(tablesFor(6, 4)).toBe(2)
  })
})

describe('tablesFree', () => {
  const lesson = { startsAt: at('2026-10-25T02:00:00Z'), endsAt: at('2026-10-25T03:00:00Z') }
  it('allows anything without a limit and fills up to the limit', () => {
    expect(tablesFree(lesson, [lesson, lesson], null)).toBe(true)
    expect(tablesFree(lesson, [lesson], 2)).toBe(true)
    expect(tablesFree(lesson, [lesson, lesson], 2)).toBe(false)
    // A group that needs two tables when only one is left.
    expect(tablesFree(lesson, [lesson], 2, 2)).toBe(false)
    expect(tablesFree(lesson, [lesson], 3, 2)).toBe(true)
  })
})

describe('rulesFor', () => {
  const venue = defaultSettings.booking

  it("takes the lesson type's own rules and the venue's for the rest", () => {
    expect(
      rulesFor(venue, { studentMoves: 0, lateCancel: { kind: 'partial', percent: 100 } }),
    ).toEqual({
      advanceDays: 14,
      minNoticeMinutes: 120,
      cancelDeadlineHours: 24,
      lateCancel: { kind: 'partial', percent: 100 },
      studentMoves: 0,
    })
  })

  it('keeps only booking rules, not the rest of the venue settings', () => {
    expect(Object.keys(rulesFor(venue, null)).sort()).toEqual([...ruleNames].sort())
  })

  it('keeps the cancel and move rules for a booking', () => {
    expect(bookingTerms(rulesFor(venue, { cancelDeadlineHours: 0 }))).toEqual({
      cancelDeadlineHours: 0,
      lateCancel: { kind: 'forfeit' },
      studentMoves: 1,
    })
  })
})

describe('ruleText', () => {
  it('says 0 in words', () => {
    expect(ruleText('cancelDeadlineHours', 0)).toBe('开课前都可以免费取消')
    expect(ruleText('minNoticeMinutes', 0)).toBe('开课前都可以预约')
    expect(ruleText('studentMoves', 0)).toBe('不允许')
    expect(ruleText('lateCancel', { kind: 'partial', percent: 0 })).toBe(
      '视为已上课，不退款，也不退回课时',
    )
  })

  it('gives each rule its value', () => {
    expect(ruleText('advanceDays', 14)).toBe('14 天以内')
    expect(ruleText('minNoticeMinutes', 90)).toBe('开课前 1.5 小时')
    expect(ruleText('cancelDeadlineHours', 24)).toBe('开课前 24 小时以上')
    expect(ruleText('lateCancel', { kind: 'partial', percent: 50 })).toBe('退还 50% 的费用')
    expect(ruleText('studentMoves', 2)).toBe('每节课 2 次')
  })
})

describe('sameTerms', () => {
  const terms = bookingTerms(defaultSettings.booking)
  it('compares values, not key order', () => {
    expect(
      sameTerms(terms, {
        studentMoves: 1,
        lateCancel: { kind: 'forfeit' },
        cancelDeadlineHours: 24,
      }),
    ).toBe(true)
  })

  it('tells any change apart', () => {
    expect(sameTerms(terms, { ...terms, cancelDeadlineHours: 48 })).toBe(false)
    expect(sameTerms(terms, { ...terms, studentMoves: 0 })).toBe(false)
    expect(sameTerms(terms, { ...terms, lateCancel: { kind: 'partial', percent: 50 } })).toBe(false)
    const half = { ...terms, lateCancel: { kind: 'partial' as const, percent: 50 } }
    expect(sameTerms(half, { ...terms, lateCancel: { kind: 'partial', percent: 60 } })).toBe(false)
  })
})
