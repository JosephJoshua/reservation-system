import { eq, sql } from 'drizzle-orm'
import { type Db, immediate, type Q } from '../db/client'
import { banners, coachCategories, coaches, lessonTypes, packageProducts } from '../db/schema'
import { ApiError } from '../errors'

/** The lists the admin orders by hand, by their path under /admin. */
export const orderedLists = {
  coaches,
  'coach-categories': coachCategories,
  'lesson-types': lessonTypes,
  'package-products': packageProducts,
  banners,
}

type OrderedTable = (typeof orderedLists)[keyof typeof orderedLists]

/** The sort value that puts a new row at the end of its list. */
export function nextSort(tx: Q, table: OrderedTable) {
  const row = tx
    .select({ last: sql<number | null>`max(${table.sort})` })
    .from(table)
    .get()
  return (row?.last ?? -1) + 1
}

/**
 * Saves a list's order as the admin arranged it. `ids` must be the whole list as it is now, so
 * an order made on a list that someone has since added to or deleted from is refused.
 */
export function saveOrder(db: Db, table: OrderedTable, ids: number[]) {
  immediate(db, (tx) => {
    const current = new Map(
      tx
        .select({ id: table.id, sort: table.sort })
        .from(table)
        .all()
        .map((r) => [r.id, r.sort]),
    )
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== current.size ||
      ids.some((id) => !current.has(id))
    ) {
      throw new ApiError(409, 'list_changed', '列表已有变化，请刷新后再调整顺序')
    }
    ids.forEach((id, sort) => {
      if (current.get(id) !== sort) tx.update(table).set({ sort }).where(eq(table.id, id)).run()
    })
  })
}
