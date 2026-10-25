import { describe, expect, it } from 'vitest'
import {
  clashes,
  exceptionError,
  freeStarts,
  type HoursPeriod,
  hoursOn,
  mergeSpans,
  type ScheduleException,
  type Span,
  spanMinutes,
  subtractSpans,
  venueDates,
  type WeeklyHours,
  weeklyHoursError,
  withinSpans,
  workingSpans,
} from './schedule'
import { venueInstant } from './time'

const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
const hours = (weekday: number, from: string, to: string): WeeklyHours => ({
  weekday,
  startMinute: m(from),
  endMinute: m(to),
})
/** A span on a venue date, from venue clock times; `to` of 24:00 is the next midnight. */
const at = (date: string, from: string, to: string): Span => ({
  startsAt: venueInstant(date, m(from)),
  endsAt: venueInstant(date, m(to)),
})
const off = (date: string, from: string, to: string): ScheduleException => ({
  kind: 'off',
  ...at(date, from, to),
})
const extra = (date: string, from: string, to: string): ScheduleException => ({
  kind: 'extra',
  ...at(date, from, to),
})
/** Venue clock times of spans on one date, as HH:MM-HH:MM. */
const clock = (spans: Span[]) =>
  spans.map((s) => {
    const t = (d: Date) => {
      const v = new Date(d.getTime() + 8 * 3_600_000)
      return v.toISOString().slice(11, 16)
    }
    return `${t(s.startsAt)}-${t(s.endsAt)}`
  })
const starts = (spans: Span[]) => clock(spans).map((s) => s.slice(0, 5))

// 2026-10-26 is a Monday (weekday 1).
const MON = '2026-10-26'
const TUE = '2026-10-27'
const always: HoursPeriod[] = [{ from: '2000-01-01', hours: [hours(1, '14:00', '18:00')] }]

describe('weeklyHoursError', () => {
  it('accepts separate and touching windows on one day', () => {
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

  it('rejects empty, reversed, off-step and out-of-day windows', () => {
    expect(weeklyHoursError([hours(1, '12:00', '12:00')])).toBe('结束时间需晚于开始时间')
    expect(weeklyHoursError([hours(1, '13:00', '12:00')])).toBe('结束时间需晚于开始时间')
    expect(weeklyHoursError([hours(1, '12:03', '13:00')])).toBe('时间需为 5 分钟的整数倍')
    expect(weeklyHoursError([{ weekday: 1, startMinute: 0, endMinute: 24 * 60 + 5 }])).toBe(
      '时间无效',
    )
    expect(weeklyHoursError([{ weekday: 7, startMinute: 0, endMinute: 60 }])).toBe('星期无效')
    expect(weeklyHoursError([{ weekday: 1, startMinute: 0.5, endMinute: 60 }])).toBe('时间无效')
  })

  it('accepts a window running to midnight', () => {
    expect(weeklyHoursError([{ weekday: 1, startMinute: 20 * 60, endMinute: 24 * 60 }])).toBeNull()
  })
})

describe('exceptionError', () => {
  const now = venueInstant(MON, m('10:00'))

  it('accepts a 请假 later today and a multi-day one', () => {
    expect(exceptionError(off(MON, '14:00', '16:00'), now)).toBeNull()
    expect(
      exceptionError(
        { kind: 'off', startsAt: venueInstant(MON, 0), endsAt: venueInstant('2026-11-02', 0) },
        now,
      ),
    ).toBeNull()
  })

  it('accepts one that already started but has not ended', () => {
    expect(exceptionError(off(MON, '08:00', '12:00'), now)).toBeNull()
  })

  it('refuses past, reversed and off-step times', () => {
    expect(exceptionError(off(MON, '08:00', '10:00'), now)).toBe('不能设置已过去的时间')
    expect(exceptionError(off(MON, '16:00', '14:00'), now)).toBe('结束时间需晚于开始时间')
    expect(exceptionError(off(MON, '14:01', '16:00'), now)).toBe('时间需为 5 分钟的整数倍')
  })

  it('keeps 加班 inside one day', () => {
    expect(exceptionError(extra(MON, '20:00', '24:00'), now)).toBeNull()
    expect(
      exceptionError(
        { kind: 'extra', startsAt: venueInstant(MON, m('22:00')), endsAt: venueInstant(TUE, 60) },
        now,
      ),
    ).toBe('加班不能跨到第二天')
  })

  it('refuses times more than a year out', () => {
    expect(exceptionError(off('2027-12-01', '10:00', '11:00'), now)).toBe('只能设置一年内的时间')
  })
})

describe('hoursOn', () => {
  const periods: HoursPeriod[] = [
    { from: '2026-10-01', hours: [hours(1, '09:00', '12:00')] },
    { from: '2026-11-01', hours: [hours(1, '14:00', '18:00')] },
  ]

  it('uses the latest period that has started', () => {
    expect(hoursOn(periods, '2026-10-31')).toEqual([hours(1, '09:00', '12:00')])
    expect(hoursOn(periods, '2026-11-01')).toEqual([hours(1, '14:00', '18:00')])
  })

  it('has no hours before the first period', () => {
    expect(hoursOn(periods, '2026-09-30')).toEqual([])
  })
})

describe('mergeSpans and subtractSpans', () => {
  it('joins overlapping and touching spans and drops empty ones', () => {
    expect(
      clock(
        mergeSpans([
          at(MON, '10:00', '11:00'),
          at(MON, '09:00', '10:00'),
          at(MON, '10:30', '12:00'),
          at(MON, '13:00', '13:00'),
          at(MON, '14:00', '15:00'),
        ]),
      ),
    ).toEqual(['09:00-12:00', '14:00-15:00'])
  })

  it('cuts holes, ends and whole spans', () => {
    const spans = [at(MON, '09:00', '12:00'), at(MON, '14:00', '18:00')]
    expect(clock(subtractSpans(spans, [at(MON, '10:00', '11:00')]))).toEqual([
      '09:00-10:00',
      '11:00-12:00',
      '14:00-18:00',
    ])
    expect(
      clock(subtractSpans(spans, [at(MON, '08:00', '09:30'), at(MON, '11:00', '15:00')])),
    ).toEqual(['09:30-11:00', '15:00-18:00'])
    expect(subtractSpans(spans, [at(MON, '00:00', '24:00')])).toEqual([])
  })
})

describe('workingSpans', () => {
  it('gives the weekly hours on their weekday only', () => {
    expect(clock(workingSpans(always, [], MON))).toEqual(['14:00-18:00'])
    expect(workingSpans(always, [], TUE)).toEqual([])
  })

  it('takes 请假 out, including part of a window', () => {
    expect(clock(workingSpans(always, [off(MON, '15:00', '16:30')], MON))).toEqual([
      '14:00-15:00',
      '16:30-18:00',
    ])
  })

  it('takes a multi-day 请假 out of every day it covers', () => {
    const week: ScheduleException = {
      kind: 'off',
      startsAt: venueInstant('2026-10-25', m('12:00')),
      endsAt: venueInstant('2026-10-28', 0),
    }
    expect(workingSpans(always, [week], MON)).toEqual([])
    expect(clock(workingSpans(always, [week], '2026-11-02'))).toEqual(['14:00-18:00'])
  })

  it('adds 加班, joined to the weekly hours it touches', () => {
    expect(clock(workingSpans(always, [extra(MON, '18:00', '20:00')], MON))).toEqual([
      '14:00-20:00',
    ])
    expect(clock(workingSpans(always, [extra(TUE, '09:00', '10:00')], TUE))).toEqual([
      '09:00-10:00',
    ])
  })

  it('lets 请假 win over 加班 at the same time', () => {
    expect(
      workingSpans([], [extra(TUE, '09:00', '12:00'), off(TUE, '00:00', '24:00')], TUE),
    ).toEqual([])
  })

  it('ignores exceptions on other dates', () => {
    expect(clock(workingSpans(always, [off(TUE, '00:00', '24:00')], MON))).toEqual(['14:00-18:00'])
  })

  it('uses the hours period in effect that day', () => {
    const periods: HoursPeriod[] = [
      { from: '2026-10-01', hours: [hours(1, '14:00', '18:00')] },
      { from: '2026-10-27', hours: [] },
    ]
    expect(clock(workingSpans(periods, [], MON))).toEqual(['14:00-18:00'])
    expect(workingSpans(periods, [], '2026-11-02')).toEqual([])
  })

  it('keeps a window running to midnight on its own date', () => {
    const late: HoursPeriod[] = [
      { from: '2000-01-01', hours: [{ weekday: 1, startMinute: 22 * 60, endMinute: 24 * 60 }] },
    ]
    const [span] = workingSpans(late, [], MON)
    expect(span?.endsAt.getTime()).toBe(venueInstant(TUE, 0).getTime())
  })
})

describe('withinSpans and clashes', () => {
  const working = [at(MON, '14:00', '16:00'), at(MON, '16:00', '18:00')]

  it('treats touching working spans as one', () => {
    expect(withinSpans(at(MON, '15:30', '16:30'), working)).toBe(true)
    expect(withinSpans(at(MON, '17:30', '18:30'), working)).toBe(false)
    expect(withinSpans(at(MON, '13:30', '14:30'), working)).toBe(false)
  })

  it('lets lessons touch, unless a buffer is kept', () => {
    expect(clashes(at(MON, '15:00', '16:00'), at(MON, '16:00', '17:00'))).toBe(false)
    expect(clashes(at(MON, '15:00', '16:00'), at(MON, '16:00', '17:00'), 10)).toBe(true)
    expect(clashes(at(MON, '17:10', '18:00'), at(MON, '16:00', '17:00'), 10)).toBe(false)
    expect(clashes(at(MON, '17:05', '18:00'), at(MON, '16:00', '17:00'), 10)).toBe(true)
  })
})

describe('freeStarts', () => {
  const working = [at(MON, '14:00', '18:00')]
  const base = { working, busy: [], minutes: 60, grid: 30 as const, buffer: 0 }

  it('offers every grid time the whole lesson fits', () => {
    expect(starts(freeStarts(base))).toEqual([
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
      '16:30',
      '17:00',
    ])
  })

  it('offers a 90 minute lesson in the same hours', () => {
    expect(clock(freeStarts({ ...base, minutes: 90 })).slice(-1)).toEqual(['16:30-18:00'])
  })

  it('offers nothing when the lesson is longer than the window', () => {
    expect(freeStarts({ ...base, minutes: 300 })).toEqual([])
  })

  it('follows the grid on the hour and every 15 minutes', () => {
    expect(starts(freeStarts({ ...base, grid: 60 }))).toEqual(['14:00', '15:00', '16:00', '17:00'])
    expect(freeStarts({ ...base, grid: 15 })).toHaveLength(13)
  })

  it('works around booked lessons and packs right after them', () => {
    const busy = [at(MON, '14:00', '15:00'), at(MON, '16:15', '17:00')]
    expect(starts(freeStarts({ ...base, busy, minutes: 60 }))).toEqual(['15:00', '17:00'])
    expect(starts(freeStarts({ ...base, busy, minutes: 30 }))).toEqual([
      '15:00',
      '15:30',
      '17:00',
      '17:30',
    ])
  })

  it('offers the time right after an off-grid lesson', () => {
    const busy = [at(MON, '14:00', '14:45')]
    expect(starts(freeStarts({ ...base, busy, minutes: 45 })).slice(0, 2)).toEqual([
      '14:45',
      '15:00',
    ])
  })

  it('keeps the buffer clear on both sides of a lesson', () => {
    const busy = [at(MON, '15:00', '16:00')]
    expect(starts(freeStarts({ ...base, busy, buffer: 10 }))).toEqual(['16:10', '16:30', '17:00'])
  })

  it('starts at an off-grid window start too', () => {
    expect(starts(freeStarts({ ...base, working: [at(MON, '14:10', '16:00')] }))).toEqual([
      '14:10',
      '14:30',
      '15:00',
    ])
  })

  it('offers nothing before notBefore', () => {
    const notBefore = venueInstant(MON, m('15:10'))
    expect(starts(freeStarts({ ...base, notBefore }))).toEqual(['15:30', '16:00', '16:30', '17:00'])
  })

  it('ignores busy time outside the working spans', () => {
    expect(freeStarts({ ...base, busy: [at(MON, '09:00', '10:00')] })).toHaveLength(7)
  })

  it('handles several windows and a lesson running to midnight', () => {
    const late = [
      at(MON, '09:00', '10:00'),
      { ...at(MON, '23:00', '23:00'), endsAt: venueInstant(TUE, 0) },
    ]
    expect(clock(freeStarts({ ...base, working: late }))).toEqual(['09:00-10:00', '23:00-00:00'])
  })
})

describe('spanMinutes', () => {
  it('counts overlapping time once', () => {
    expect(spanMinutes([at(MON, '14:00', '16:00'), at(MON, '15:00', '17:00')])).toBe(180)
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
