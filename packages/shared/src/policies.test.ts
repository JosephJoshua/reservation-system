import { describe, expect, it } from 'vitest'
import { privacyPolicyText } from './policies'
import { defaultSettings } from './settings'

describe('privacyPolicyText', () => {
  const text = privacyPolicyText(defaultSettings)

  it('says what coaches see of a lesson’s payment', () => {
    expect(text).toContain('该课程的付款方式和金额（含所用课时包）')
  })

  it('covers contacting a student with lessons left', () => {
    expect(text).toContain('你有剩余课时但较长时间未上课时，由场馆工作人员联系你')
  })

  it('names the scanner used for 扫码签到', () => {
    expect(text).toContain('在你点击“扫码签到”时打开微信扫一扫')
  })

  it('says erased data stays in backups for a while', () => {
    expect(text).toContain('已删除的信息在数据备份中最多保留 30 天')
  })
})
