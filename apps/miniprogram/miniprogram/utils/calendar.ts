import type { BookingDto, HomeDto } from '../lib/shared'
import { ask } from './tap'

/** Remind an hour before the lesson starts. */
const ALARM_OFFSET_SECONDS = 3600

// The system sheet takes a moment to appear, so a double tap would otherwise add the lesson twice.
let adding = false

/** Adds a lesson to the phone's calendar, with the venue as its place. */
export async function addLessonToCalendar(
  b: BookingDto,
  venue: HomeDto['venue'] | null,
): Promise<void> {
  if (adding) return
  adding = true
  try {
    await wx.addPhoneCalendar({
      title: `${b.lessonType.name} · ${b.coach.name}`,
      startTime: Math.floor(Date.parse(b.startsAt) / 1000),
      endTime: String(Math.floor(Date.parse(b.endsAt) / 1000)),
      alarm: true,
      alarmOffset: ALARM_OFFSET_SECONDS,
      location: venue ? [venue.name, venue.address].filter(Boolean).join(' ') : '',
      description: [
        `教练：${b.coach.name}`,
        venue?.phone ? `场馆电话：${venue.phone}` : '',
        '取消或改约请在小程序中操作，日历不会自动更新。',
      ]
        .filter(Boolean)
        .join('\n'),
    })
    wx.showToast({ title: '已添加到日历', icon: 'success' })
  } catch (e) {
    const msg = (e as { errMsg?: string }).errMsg ?? ''
    // Closed the sheet, or turned down the privacy prompt, which explains itself.
    if (/cancel|privacy permission/i.test(msg)) return
    if (/auth/i.test(msg)) {
      const answer = await ask({
        title: '无法添加到日历',
        content: '请在设置中允许添加日历事件。',
        confirmText: '去设置',
      })
      if (answer?.confirm) wx.openSetting({})
      return
    }
    wx.showToast({ title: '添加失败，请稍后重试', icon: 'none' })
  } finally {
    adding = false
  }
}
