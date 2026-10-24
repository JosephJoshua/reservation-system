import { venueParts } from '@rs/shared'
import { and, eq, gt, isNull, lte, ne, notExists, or, sql } from 'drizzle-orm'
import { immediate, type Q } from '../db/client'
import { packageNotices, packages, students } from '../db/schema'
import type { Deps } from '../deps'
import { getSettings } from './settings'
import { wechatOpenid } from './student-link'

const BATCH = 50
const DAY_MS = 86_400_000
/** How long before expiry a package with lessons left is reminded of. */
export const EXPIRY_NOTICE_MS = 7 * DAY_MS
/** How far ahead the admin 即将到期 filter looks, so the front desk can call in time. */
export const EXPIRING_SOON_MS = 30 * DAY_MS
// A message that could not reach WeChat for this long is no longer news.
const STALE_MS = DAY_MS
const RETRY_MS = 5 * 60_000

/** The last day a package can be used, as 2026年11月22日: it expires at the end of that day. */
export function lastDay(expiresAt: Date) {
  const p = venueParts(new Date(expiresAt.getTime() - 1))
  return `${p.year}年${p.month}月${p.day}日`
}

/** Queues and sends package messages. Run by the sweeper. */
export async function notifyPackages(deps: Deps) {
  immediate(deps.db, (tx) => queueFromPackages(tx, deps.now()))
  await sendPending(deps)
}

function hasNotice(db: Q, kind: 'expiring' | 'used_up') {
  return db
    .select({ one: sql`1` })
    .from(packageNotices)
    .where(
      and(
        eq(packageNotices.packageId, packages.id),
        eq(packageNotices.kind, kind),
        // An extended package is reminded of its new date; used up is told once.
        kind === 'expiring' ? eq(packageNotices.expiresAt, packages.expiresAt) : undefined,
      ),
    )
}

function queueFromPackages(db: Q, at: Date) {
  const due = [
    {
      kind: 'expiring' as const,
      rows: db
        .select({ id: packages.id, expiresAt: packages.expiresAt })
        .from(packages)
        .where(
          and(
            eq(packages.status, 'active'),
            gt(packages.lessonsRemaining, 0),
            gt(packages.expiresAt, at),
            lte(packages.expiresAt, new Date(at.getTime() + EXPIRY_NOTICE_MS)),
            // A package that never lasted longer than the reminder window was bought knowing it.
            lte(packages.createdAt, sql`${packages.expiresAt} - ${EXPIRY_NOTICE_MS}`),
            notExists(hasNotice(db, 'expiring')),
          ),
        )
        .limit(BATCH)
        .all(),
    },
    {
      kind: 'used_up' as const,
      rows: db
        .select({ id: packages.id, expiresAt: packages.expiresAt })
        .from(packages)
        .where(
          and(
            eq(packages.status, 'active'),
            lte(packages.lessonsRemaining, 0),
            gt(packages.expiresAt, at),
            notExists(hasNotice(db, 'used_up')),
          ),
        )
        .limit(BATCH)
        .all(),
    },
  ]
  for (const { kind, rows } of due) {
    for (const p of rows) {
      db.insert(packageNotices)
        .values({ packageId: p.id, kind, expiresAt: p.expiresAt, createdAt: at })
        .onConflictDoNothing()
        .run()
    }
  }
}

/**
 * Whether the student has another package left to book the same lessons with: same lesson type,
 * and every coach this one allowed.
 */
function hasOtherPackage(db: Q, p: typeof packages.$inferSelect, now: Date) {
  return db
    .select({ coachIds: packages.coachIds })
    .from(packages)
    .where(
      and(
        eq(packages.studentId, p.studentId),
        eq(packages.lessonTypeId, p.lessonTypeId),
        ne(packages.id, p.id),
        eq(packages.status, 'active'),
        gt(packages.lessonsRemaining, 0),
        gt(packages.expiresAt, now),
      ),
    )
    .all()
    .some(
      (o) =>
        o.coachIds.length === 0 ||
        (p.coachIds.length > 0 && p.coachIds.every((id) => o.coachIds.includes(id))),
    )
}

async function sendPending(deps: Deps) {
  const { db } = deps
  const pending = db
    .select({ id: packageNotices.id })
    .from(packageNotices)
    .where(
      and(
        isNull(packageNotices.doneAt),
        or(isNull(packageNotices.retryAt), lte(packageNotices.retryAt, deps.now())),
      ),
    )
    .orderBy(packageNotices.id)
    .limit(BATCH)
    .all()
  if (pending.length === 0) return
  const place = getSettings(db).venue.name
  const template = deps.notifier?.template('student_package')

  for (const { id } of pending) {
    const now = deps.now()
    // Claimed for the send, and read once claimed so it says what is true now.
    const claimed = db
      .update(packageNotices)
      .set({ doneAt: now })
      .where(and(eq(packageNotices.id, id), isNull(packageNotices.doneAt)))
      .run()
    if (claimed.changes !== 1) continue
    const n = db
      .select({
        notice: packageNotices,
        pkg: packages,
        openid: students.openid,
        name: students.name,
      })
      .from(packageNotices)
      .innerJoin(packages, eq(packages.id, packageNotices.packageId))
      .innerJoin(students, eq(students.id, packages.studentId))
      .where(eq(packageNotices.id, id))
      .get()
    if (!n) continue
    const { notice, pkg } = n
    const live = pkg.status === 'active' && pkg.expiresAt > now
    // No longer true: a lesson came back or the last ones were booked, or the expiry moved.
    // Removed, so it is queued again should it become true again.
    const changed =
      live &&
      (notice.kind === 'used_up'
        ? pkg.lessonsRemaining > 0
        : pkg.lessonsRemaining <= 0 || pkg.expiresAt.getTime() !== notice.expiresAt.getTime())
    if (changed) {
      db.delete(packageNotices).where(eq(packageNotices.id, id)).run()
      continue
    }
    const outdated =
      !live ||
      now.getTime() - notice.createdAt.getTime() > STALE_MS ||
      // Already renewed: nothing to tell.
      (notice.kind === 'used_up' && hasOtherPackage(db, pkg, now))
    // Deleted and front-desk accounts hold a placeholder openid.
    const reachable = wechatOpenid(n.openid)
    let result: 'sent' | 'refused' | 'skipped' = 'skipped'
    if (deps.notifier && template && reachable && !outdated) {
      try {
        result = await deps.notifier.send(reachable, template, 'pages/my-packages/index', {
          student: n.name || '学员',
          package: pkg.name,
          left: `${pkg.lessonsRemaining}节`,
          expiry: lastDay(pkg.expiresAt),
          place,
          status: notice.kind === 'expiring' ? '即将到期' : '课时已约完',
          note:
            notice.kind === 'expiring'
              ? `还有${pkg.lessonsRemaining}节未约，到期后不能再约课`
              : '课时已全部约完，可续购课时包',
        })
        if (result === 'refused') deps.log('package notice refused', { packageId: pkg.id })
      } catch (e) {
        deps.log('package notice failed', { packageId: pkg.id, error: (e as Error).message })
        db.update(packageNotices)
          .set({ doneAt: null, retryAt: new Date(now.getTime() + RETRY_MS) })
          .where(eq(packageNotices.id, id))
          .run()
        continue
      }
    }
    db.update(packageNotices).set({ doneAt: now, result }).where(eq(packageNotices.id, id)).run()
  }
}
