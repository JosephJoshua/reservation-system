import { ApiError } from './errors'

/** Exchanges a wx.login code for an openid with code2Session. */
export function wechatLogin(appId: string, secret: string, fetchImpl: typeof fetch = fetch) {
  return async (code: string) => {
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
    url.search = new URLSearchParams({
      appid: appId,
      secret,
      js_code: code,
      grant_type: 'authorization_code',
    }).toString()
    let data: { openid?: string; errcode?: number; errmsg?: string }
    try {
      data = (await (
        await fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
      ).json()) as typeof data
    } catch {
      throw new ApiError(502, 'wx_unavailable', '微信登录暂不可用，请稍后再试')
    }
    if (!data.openid) throw new ApiError(401, 'wx_login_failed', '微信登录失败，请重试')
    return data.openid
  }
}

/**
 * Development login without an AppSecret: every code maps to one dev student, except codes of the
 * form `dev:<name>`, which tests and QA use to act as several students.
 */
export async function devLogin(code: string) {
  return code.startsWith('dev:') ? `dev_${code.slice(4)}` : 'dev_student'
}

const WX_TIMEOUT_MS = 15_000

/**
 * The server's access token for WeChat's server APIs, fetched once and kept until shortly before
 * it expires. `reset` drops it after WeChat says it is no longer valid.
 */
export function wechatAccessToken(appId: string, secret: string, fetchImpl: typeof fetch = fetch) {
  let token: { value: string; expiresAt: number } | null = null
  async function get() {
    if (token && token.expiresAt > Date.now()) return token.value
    // The stable token endpoint does not invalidate tokens other servers already hold.
    const res = await fetchImpl('https://api.weixin.qq.com/cgi-bin/stable_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credential', appid: appId, secret }),
      signal: AbortSignal.timeout(WX_TIMEOUT_MS),
    })
    const data = (await res.json()) as {
      access_token?: string
      expires_in?: number
      errmsg?: string
    }
    if (!data.access_token) throw new Error(`access token: ${data.errmsg ?? res.status}`)
    token = {
      value: data.access_token,
      expiresAt: Date.now() + ((data.expires_in ?? 7200) - 300) * 1000,
    }
    return token.value
  }
  return Object.assign(get, {
    reset: () => {
      token = null
    },
  })
}

export type AccessToken = ReturnType<typeof wechatAccessToken>

/** Makes a mini program code (小程序码) image that opens `page` with `scene`. */
export type MiniCode = (scene: string, page: string) => Promise<Uint8Array>

export function wechatMiniCode(
  accessToken: AccessToken,
  state: 'developer' | 'trial' | 'formal',
  fetchImpl: typeof fetch = fetch,
): MiniCode {
  const envVersion = { developer: 'develop', trial: 'trial', formal: 'release' }[state]
  return async (scene, page) => {
    const res = await fetchImpl(
      `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${await accessToken()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene,
          page,
          // A page not yet in the released version can still be opened from a trial build.
          check_path: state === 'formal',
          env_version: envVersion,
          width: 430,
        }),
        signal: AbortSignal.timeout(WX_TIMEOUT_MS),
      },
    )
    // The image on success; a JSON error otherwise.
    if (res.ok && res.headers.get('content-type')?.startsWith('image/')) {
      return new Uint8Array(await res.arrayBuffer())
    }
    const err = (await res.json().catch(() => ({ errmsg: `http ${res.status}` }))) as {
      errcode?: number
      errmsg?: string
    }
    if (err.errcode === 40001 || err.errcode === 42001) accessToken.reset()
    throw new Error(`mini code: ${err.errcode} ${err.errmsg ?? ''}`)
  }
}
