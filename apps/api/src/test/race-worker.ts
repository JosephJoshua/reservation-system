// Run by race.test.ts in separate processes: books one slot at an agreed instant.
import { openDb } from '../db/client'
import type { Deps } from '../deps'
import { ApiError } from '../errors'
import { FakeGateway } from '../pay/fake'
import { createBooking } from '../services/bookings'

const [dbPath, slotId, lessonTypeId, studentId, startAt, now] = process.argv.slice(2)
const deps: Deps = {
  db: openDb(dbPath as string),
  gateway: new FakeGateway(),
  now: () => new Date(now as string),
  wxLogin: async () => '',
  uploadsDir: '',
  log: () => {},
}
while (Date.now() < Number(startAt)) {
  // Spin so every process starts its transaction at the same moment.
}
createBooking(deps, Number(studentId), {
  slotId: Number(slotId),
  lessonTypeId: Number(lessonTypeId),
})
  .then((r) => console.log(JSON.stringify({ ok: true, status: r.status })))
  .catch((e) =>
    console.log(JSON.stringify({ ok: false, code: e instanceof ApiError ? e.code : String(e) })),
  )
