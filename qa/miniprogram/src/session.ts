import type automator from 'miniprogram-automator'

type MiniProgram = Awaited<ReturnType<typeof automator.launch>>

const api = (process.env.API_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const storedToken = async (miniProgram: MiniProgram) =>
  (await miniProgram.callWxMethod('getStorageSync', 'token')) as string

/**
 * Makes the mini program's next login the dev student `login`. A page may still be logging in
 * under the previous name, and its token would land after the session is cleared, so the run
 * would act as someone else. This names the new login first, lets a pending login store its
 * token, and only then clears the session. Call expectStudent once the next page has loaded.
 */
export async function switchStudent(miniProgram: MiniProgram, login: string) {
  await miniProgram.callWxMethod('setStorageSync', 'devLogin', login)
  // Cleared before waiting, so a token left by an earlier run does not end the wait early.
  await miniProgram.callWxMethod('removeStorageSync', 'token')
  for (let i = 0; i < 12 && !(await storedToken(miniProgram)); i++) await sleep(250)
  await sleep(500)
  for (const key of ['token', 'coachToken']) {
    await miniProgram.callWxMethod('removeStorageSync', key)
  }
}

async function studentId(token: string): Promise<number | undefined> {
  const res = await fetch(`${api}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
  return res.ok ? ((await res.json()) as { id: number }).id : undefined
}

/**
 * Waits for the page's session and fails unless it belongs to the dev student `login`. Call it on
 * a page that makes a signed-in request; one served from cached data never logs in.
 */
export async function expectStudent(miniProgram: MiniProgram, login: string) {
  const res = await fetch(`${api}/api/auth/student`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: `dev:${login}` }),
  })
  if (!res.ok) throw new Error(`dev login ${login} failed: ${res.status}`)
  const want = await studentId(((await res.json()) as { token: string }).token)
  for (let i = 0; i < 40; i++) {
    const token = await storedToken(miniProgram)
    if (token) {
      const got = await studentId(token)
      if (got === want) return
      throw new Error(`the mini program is signed in as student ${got}, not ${login} (${want})`)
    }
    await sleep(250)
  }
  throw new Error(`the mini program never signed in as ${login}`)
}
