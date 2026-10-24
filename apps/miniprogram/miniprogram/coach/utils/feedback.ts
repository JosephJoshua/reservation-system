import { ask } from '../../utils/tap'
import { modalDangerColor } from '../../utils/theme'

/** Asks before a coach deletes a lesson's feedback; true once they confirm. */
export async function confirmDeleteFeedback(): Promise<boolean> {
  const answer = await ask({
    title: '删除这条点评？',
    content: '照片会一起删除，学员也将看不到这条点评。',
    confirmText: '删除',
    confirmColor: modalDangerColor(),
    cancelText: '再想想',
  })
  return Boolean(answer?.confirm)
}
