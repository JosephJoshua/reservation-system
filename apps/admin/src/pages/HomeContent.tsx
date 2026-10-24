import { useState } from 'react'
import { Card, DatePicker, Input, Loading, Space, Textarea } from 'tdesign-react'
import { Field } from '../Field'
import { isoToPicker, pickerToIso } from '../format'
import { useApi, useIsPhone } from '../hooks'
import { EditorWithPreview } from '../preview/EditorWithPreview'
import { SaveBar } from '../SaveBar'
import { useSettingsDraft } from '../settingsDraft'
import type { Banner } from '../types'
import { Banners } from './Banners'

/**
 * What students read: the 预约 tab's banners and notice, and the 预约须知 shown before they book,
 * beside a live preview of the tab. The notice and 预约须知 are part of the settings and are
 * saved with the bar; banners save one by one as before.
 */
export function HomeContent() {
  const { error, s, set, reset, save, saving, changed } = useSettingsDraft()
  const banners = useApi<Banner[]>('/admin/banners')
  const phone = useIsPhone()
  // The banner 预览 put on the preview's carousel.
  const [shown, setShown] = useState<number>()

  if (!s) return error ? <p className="muted">{error}</p> : <Loading size="small" />

  const dirty = changed((v) => [v.notice, v.policies.booking])

  return (
    <div className="home-content">
      <EditorWithPreview
        // The page header and padding above, and room below the phone.
        chrome={136}
        draft={{
          kind: 'home',
          id: null,
          venue: s.venue,
          notice: s.notice,
          payment: s.payment,
          banners: banners.data ?? undefined,
          bannerId: shown,
        }}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Banners
            banners={banners}
            // On a phone the preview is behind a switch, so 预览 opens it in a dialog instead.
            onPreview={phone ? undefined : (b) => setShown(b.id)}
          />

          <Card title="首页公告" bordered>
            <div className="fields form-narrow">
              <Field label="公告" help="一句话，显示在轮播图下方。留空则不显示">
                <Input
                  value={s.notice.text}
                  maxlength={60}
                  onChange={(v) =>
                    set((d) => {
                      d.notice.text = String(v)
                    })
                  }
                />
              </Field>
              <Field label="结束时间" help="到时自动隐藏，不填则一直显示">
                <DatePicker
                  enableTimePicker
                  clearable
                  value={isoToPicker(s.notice.endsAt)}
                  onChange={(v) =>
                    set((d) => {
                      d.notice.endsAt = pickerToIso(String(v || ''))
                    })
                  }
                />
              </Field>
            </div>
          </Card>

          <Card title="预约须知" bordered>
            <div className="fields form-narrow">
              <Field label="内容" help="学员确认预约时可以查看，“我的”页也有入口。留空则不显示">
                <Textarea
                  value={s.policies.booking}
                  maxlength={2000}
                  autosize={{ minRows: 4 }}
                  placeholder="如：请提前 10 分钟到场，自备球拍和运动鞋"
                  onChange={(v) =>
                    set((d) => {
                      d.policies.booking = String(v)
                    })
                  }
                />
              </Field>
            </div>
          </Card>
        </Space>
      </EditorWithPreview>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
    </div>
  )
}
