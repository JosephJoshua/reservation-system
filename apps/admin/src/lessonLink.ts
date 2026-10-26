import { useEffect, useState } from 'react'
import { hashParam } from './hooks'
import { SHOW_SECTION } from './SectionNav'

/** Fired after 课程详情 changed a lesson, so the lists showing it load again. */
export const LESSON_CHANGED = 'rs:lesson-changed'

export const lessonChanged = () => window.dispatchEvent(new Event(LESSON_CHANGED))

/** Loads a list again whenever 课程详情 changed a lesson. */
export function useOnLessonChanged(reload: () => unknown) {
  useEffect(() => {
    const on = () => void reload()
    window.addEventListener(LESSON_CHANGED, on)
    return () => window.removeEventListener(LESSON_CHANGED, on)
  }, [reload])
}

function withLesson(slotId: number | null) {
  const [path, query] = window.location.hash.split('?')
  const params = new URLSearchParams(query ?? '')
  if (slotId) params.set('lesson', String(slotId))
  else params.delete('lesson')
  const rest = params.toString()
  return `${path}${rest ? `?${rest}` : ''}`
}

/** Opens 课程详情 over the page shown, with the lesson in the address so back closes it. */
export function openLesson(slotId: number) {
  window.location.hash = withLesson(slotId)
}

/** Closes 课程详情, replacing the address rather than adding a step for back. */
export function closeLesson() {
  history.replaceState(history.state, '', withLesson(null) || '#/')
  window.dispatchEvent(new Event(SHOW_SECTION))
}

const lessonParam = () => {
  const id = Number(hashParam('lesson'))
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** The lesson open over the page, from `?lesson=` in the address. */
export function useLessonParam() {
  const [id, setId] = useState(lessonParam)
  useEffect(() => {
    const on = () => setId(lessonParam())
    window.addEventListener('hashchange', on)
    window.addEventListener(SHOW_SECTION, on)
    return () => {
      window.removeEventListener('hashchange', on)
      window.removeEventListener(SHOW_SECTION, on)
    }
  }, [])
  return id
}
