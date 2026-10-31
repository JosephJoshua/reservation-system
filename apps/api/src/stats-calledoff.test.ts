import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { bookings, lessonTypes, slots, students } from './db/schema'
import { dashboard, statsReport } from './services/stats'
import { type Harness, setup } from './test/harness'

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** A group session on `day` at `hour` with two seats still confirmed. */
function groupSession(h: Harness, coachId: number, day: string, calledOff: boolean, hour = 10) {
  const group = h.db
    .insert(lessonTypes)
    .values({ name: '小班', durationMinutes: 60, price: 10000, capacity: 4 })
    .returning()
    .get()
  const s = h.slot(coachId, day, hour)
  h.db
    .update(slots)
    .set({
      lessonTypeId: group.id,
      capacity: 4,
      ...(calledOff ? { cancelledAt: new Date(s.startsAt.getTime() - 3_600_000) } : {}),
      cancelReason: calledOff ? '人数不足' : null,
    })
    .where(eq(slots.id, s.id))
    .run()
  for (const n of [1, 2]) {
    const st = h.db
      .insert(students)
      .values({ openid: `o${day}-${hour}-${n}`, name: `学员${n}` })
      .returning()
      .get()
    h.db
      .insert(bookings)
      .values({
        slotId: s.id,
        seat: n,
        studentId: st.id,
        lessonTypeId: group.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status: 'confirmed',
        paidWith: 'order',
        price: 10000,
      })
      .run()
  }
  return s
}

describe('a group session the venue called off with a seat left live', () => {
  it('is not counted as taught or unmarked in the stats and the overview', () => {
    const h = setup({ now: '2026-10-22T02:00:00Z' })
    const { coach } = h.seed()
    groupSession(h, coach.id, '2026-10-20', true)
    const report = statsReport(h.deps, '2026-10-01', '2026-10-31')
    expect(sum(report.lessons)).toBe(0)
    expect(report.attendance).toMatchObject({ attended: 0, noShow: 0, unmarked: 0 })
    expect(dashboard(h.deps).unmarked).toBe(0)
  })

  it('still counts a session that went ahead', () => {
    const h = setup({ now: '2026-10-22T02:00:00Z' })
    const { coach } = h.seed()
    groupSession(h, coach.id, '2026-10-20', false)
    const report = statsReport(h.deps, '2026-10-01', '2026-10-31')
    expect(sum(report.lessons)).toBe(1)
    expect(report.attendance.unmarked).toBe(2)
    expect(dashboard(h.deps).unmarked).toBe(2)
  })

  it('leaves it out of today, and shows a deleted student as such', () => {
    const h = setup({ now: '2026-10-22T00:00:00Z' })
    const { coach } = h.seed()
    groupSession(h, coach.id, '2026-10-22', true)
    expect(dashboard(h.deps).sessions).toEqual([])
    const live = groupSession(h, coach.id, '2026-10-22', false, 14)
    const seat = h.db.select().from(bookings).where(eq(bookings.slotId, live.id)).all()[0]
    h.db
      .update(students)
      .set({ deletedAt: h.deps.now(), name: '' })
      .where(eq(students.id, seat?.studentId ?? 0))
      .run()
    const [today] = dashboard(h.deps).sessions
    expect(today?.students.map((s) => s.student.name)).toEqual(['已注销学员', '学员2'])
  })
})
