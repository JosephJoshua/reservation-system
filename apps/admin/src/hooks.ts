import { useCallback, useEffect, useRef, useState } from 'react'
import { MessagePlugin } from 'tdesign-react'
import { api, RequestError } from './api'

/** Loads a GET endpoint; `reload` fetches again. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  const reload = useCallback(async () => {
    if (!path) return
    const mine = ++seq.current
    setLoading(true)
    try {
      const result = await api<T>('GET', path)
      if (mine === seq.current) {
        setData(result)
        setError(null)
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [path])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, loading, reload, setData }
}

/** Runs a change, shows its error as a message, and reports success. */
export async function attempt(fn: () => Promise<unknown>, success?: string): Promise<boolean> {
  try {
    await fn()
    if (success) void MessagePlugin.success(success)
    return true
  } catch (e) {
    void MessagePlugin.error(e instanceof RequestError ? e.message : '操作失败，请重试')
    return false
  }
}
