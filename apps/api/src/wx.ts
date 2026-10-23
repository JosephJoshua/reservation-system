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
      data = (await (await fetchImpl(url)).json()) as typeof data
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
