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

/** The address without an open lesson, to tell a lesson opening from a page change. */
export const withoutLesson = (hash: string) => {
  const [path, query] = hash.split('?')
  const params = new URLSearchParams(query ?? '')
  params.delete('lesson')
  const rest = params.toString()
  return `${path}${rest ? `?${rest}` : ''}`
}

// This load of the page: a mark left by an earlier load, kept by the browser over a refresh, has
// no step of this page behind it to go back to.
const DOC = Math.random().toString(36).slice(2)

/** Opens 课程详情 over the page shown, with the lesson in the address so back closes it. */
export function openLesson(slotId: number) {
  const opened = !hashParam('lesson')
  window.location.hash = withLesson(slotId)
  // Marks the step so closing goes back over it, rather than leaving the same address twice.
  if (opened) history.replaceState({ ...history.state, lessonOpened: DOC }, '')
}

/** Shows another lesson in 课程详情, such as where a lesson was moved, without a step for back. */
export function showLesson(slotId: number, from: number) {
  // Only while that lesson is still the one shown.
  if (hashParam('lesson') !== String(from)) return
  history.replaceState(history.state, '', withLesson(slotId))
  window.dispatchEvent(new Event(SHOW_SECTION))
}

// Going back over the step that opened the lesson, which takes a moment: Esc reaches both the
// drawer and the page's own listener, and only one of them may go back.
let leaving = false

/** Closes 课程详情: back over the step that opened it, or out of the address of a link. */
export function closeLesson() {
  if (leaving || !hashParam('lesson')) return
  if (history.state?.lessonOpened === DOC) {
    leaving = true
    window.addEventListener(
      'hashchange',
      () => {
        leaving = false
      },
      { once: true },
    )
    history.back()
    return
  }
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
