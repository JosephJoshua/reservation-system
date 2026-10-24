// The mini program pages the previews show, written after their wxml (apps/miniprogram/
// miniprogram/pages) with the same classes and the same view data their page code works out.
// Keep each in step with its page when the page changes.
import { formatYuan, type HomeDto, VENUE_TIME_ZONE, venueDateKey } from '@rs/shared'
import { type CatalogData, priceText, yuan } from './data'
import { profileHtml } from './rich-text'
import { TAvatar, TButton, TCell, TCellGroup, TEmpty, TIcon, TNoticeBar, TTag } from './td'

/** Marks the element the frame scrolls into view, such as the row being edited. */
const FOCUS = { 'data-preview-focus': true }

/** pages/booking: the 预约 tab. `bannerId` is the slide shown, as if the swiper were on it. */
export function HomeScreen({
  catalog,
  venue,
  notice,
  noticeLinked,
  bannerId,
  focus,
}: {
  catalog: CatalogData
  venue: HomeDto['venue']
  notice: string
  noticeLinked: boolean
  bannerId?: number
  focus?: { kind: 'lessonType' | 'coach'; id: number }
}) {
  const banners = catalog.banners
  const current = Math.max(
    0,
    banners.findIndex((b) => b.id === bannerId),
  )
  const banner = banners[current]
  const lessonTypes = catalog.lessonTypes.map((t) => {
    const { price, original } = priceText(t.fromPrice)
    const prices = new Set(
      catalog.coaches.flatMap((c) =>
        c.lessons.filter((l) => l.lessonTypeId === t.id).map((l) => l.price.price),
      ),
    )
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      duration:
        t.capacity > 1
          ? `${t.durationMinutes}分钟 · 最多${t.capacity}人`
          : `${t.durationMinutes}分钟`,
      isTrial: t.isTrial,
      isGroup: t.capacity > 1,
      price,
      original,
      from: prices.size > 1,
    }
  })
  const showVenue = venue.address || venue.phone || venue.openingHours
  const venueCells = [
    venue.openingHours && {
      key: 'hours',
      title: '营业时间',
      note: venue.openingHours,
      icon: 'time' as const,
    },
    venue.address && {
      key: 'address',
      title: venue.address,
      icon: 'location' as const,
      arrow: true,
    },
    venue.phone && {
      key: 'phone',
      title: '联系场馆',
      note: venue.phone,
      icon: 'call' as const,
      arrow: true,
    },
  ].filter((c) => !!c)

  return (
    <div className="home">
      {banner && (
        <div className="banners mp-swiper">
          <div className="mp-swiper-item" {...(bannerId !== undefined ? FOCUS : {})}>
            {banner.imageUrl ? (
              <img className="banner-image mp-image-fill" src={banner.imageUrl} alt="" />
            ) : (
              <div className="banner-image mp-image-empty" />
            )}
            {banner.title && <div className="banner-title">{banner.title}</div>}
          </div>
          {banners.length > 1 && (
            <div className="mp-swiper-dots">
              {banners.map((b, i) => (
                <span key={b.id} className={i === current ? 'active' : undefined} />
              ))}
            </div>
          )}
        </div>
      )}

      {notice && (
        <div className="notice">
          <TNoticeBar content={notice} marquee={notice.length > 22} linked={noticeLinked} />
        </div>
      )}

      <div className="section-title">选择课程</div>
      {lessonTypes.length ? (
        <div className="card">
          {lessonTypes.map((item) => (
            <div
              key={item.id}
              className="lesson"
              {...(focus?.kind === 'lessonType' && focus.id === item.id ? FOCUS : {})}
            >
              <div className="lesson-main">
                <div className="lesson-name">
                  <span>{item.name}</span>
                  {item.isTrial && (
                    <div className="lesson-tag">
                      <TTag size="small" theme="primary" variant="light">
                        体验
                      </TTag>
                    </div>
                  )}
                  {item.isGroup && (
                    <div className="lesson-tag">
                      <TTag size="small" theme="primary" variant="light">
                        小班
                      </TTag>
                    </div>
                  )}
                </div>
                {item.description && <div className="lesson-desc">{item.description}</div>}
                <div className="lesson-meta">{item.duration}</div>
              </div>
              <div className="lesson-side">
                {item.price && (
                  <div>
                    <span className="price">{item.price}</span>
                    {item.from && <span className="muted lesson-from">起</span>}
                  </div>
                )}
                {item.original && <div className="price-original">{item.original}</div>}
              </div>
              <div className="row-arrow">
                <TIcon name="chevron-right" size="20px" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <div className="inline-empty">
            <TEmpty icon="calendar" size="56px" description="暂无可预约的课程" />
          </div>
        </div>
      )}

      {catalog.coaches.length > 0 && (
        <>
          <div className="section-title">教练团队</div>
          <div className="card">
            {catalog.coaches.map((item) => (
              <div
                key={item.id}
                className="lesson"
                {...(focus?.kind === 'coach' && focus.id === item.id ? FOCUS : {})}
              >
                <TAvatar image={item.avatarUrl} size="44px" />
                <div className="lesson-main coach-main">
                  <div className="lesson-name">
                    <span>{item.name}</span>
                    {item.category && (
                      <div className="lesson-tag">
                        <TTag size="small" theme="primary" variant="light">
                          {item.category}
                        </TTag>
                      </div>
                    )}
                  </div>
                  {item.title && <div className="coach-title">{item.title}</div>}
                </div>
                <div className="row-arrow">
                  <TIcon name="chevron-right" size="20px" />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {catalog.packageProducts.length > 0 && (
        <>
          <div className="section-title">课时包</div>
          <TCellGroup>
            <TCell
              title="购买课时包"
              description="多节一起买，单节更划算"
              leftIcon="wallet"
              arrow
              last
            />
          </TCellGroup>
        </>
      )}

      {showVenue && (
        <>
          <div className="section-title">场馆信息</div>
          <TCellGroup>
            {venueCells.map((c, i) => (
              <TCell
                key={c.key}
                title={c.key === 'address' ? <div className="address">{c.title}</div> : c.title}
                note={'note' in c ? c.note : undefined}
                leftIcon={c.icon}
                arrow={'arrow' in c}
                last={i === venueCells.length - 1}
              />
            ))}
          </TCellGroup>
        </>
      )}
      <div className="bottom-space" />
    </div>
  )
}

/** pages/coach-detail: a coach's page. */
export function CoachScreen({
  catalog,
  coachId,
  profile,
}: {
  catalog: CatalogData
  coachId: number
  profile: string
}) {
  const coach = catalog.coaches.find((c) => c.id === coachId)
  if (!coach) return null
  const lessons = coach.lessons.flatMap((l) => {
    const type = catalog.lessonTypes.find((t) => t.id === l.lessonTypeId)
    if (!type) return []
    return [
      {
        id: type.id,
        name: type.name,
        duration: `${type.durationMinutes}分钟`,
        ...priceText(l.price),
      },
    ]
  })
  const html = profileHtml(profile)
  return (
    <div className={lessons.length ? 'has-action-bar' : 'bottom-space'}>
      <div className="profile-head card">
        <TAvatar image={coach.avatarUrl} size="68px" />
        <div className="head-text">
          <div className="head-name">
            <span>{coach.name}</span>
            {coach.category && (
              <div className="head-tag">
                <TTag size="small" theme="primary" variant="light">
                  {coach.category}
                </TTag>
              </div>
            )}
          </div>
          {coach.title && <div className="head-title">{coach.title}</div>}
          {coach.tags.length > 0 && (
            <div className="head-tags">
              {coach.tags.map((t) => (
                <TTag key={t} size="small" variant="outline">
                  {t}
                </TTag>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="section-title">课程与价格</div>
      {lessons.length === 0 ? (
        <div className="card">
          <div className="inline-empty">
            <TEmpty icon="calendar" size="48px" description="这位教练暂未开放预约" />
          </div>
        </div>
      ) : (
        <div className="card">
          {lessons.map((item) => (
            <div key={item.id} className="lesson">
              <div className="lesson-main">
                <div className="lesson-name">{item.name}</div>
                <div className="lesson-meta">{item.duration}</div>
              </div>
              <div className="lesson-side">
                <span className="price">{item.price}</span>
                {item.original && <div className="price-original">{item.original}</div>}
              </div>
              <div className="row-arrow">
                <TIcon name="chevron-right" size="20px" />
              </div>
            </div>
          ))}
        </div>
      )}

      {html && (
        <>
          <div className="section-title">教练介绍</div>
          {/* Cleaned by profileHtml to the tags the API keeps. */}
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: cleaned above */}
          <div className="card profile-body" dangerouslySetInnerHTML={{ __html: html }} />
        </>
      )}

      {lessons.length > 0 && (
        <div className="action-bar">
          <div className="grow">
            <TButton theme="primary" size="large" className="action-button">
              预约{coach.name}
            </TButton>
          </div>
        </div>
      )}
    </div>
  )
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const venueDay = new Intl.DateTimeFormat('en-US', { timeZone: VENUE_TIME_ZONE, weekday: 'short' })
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The day strip as utils/format bookableDays builds it. */
function bookableDays(advanceDays: number, now: number) {
  return Array.from({ length: advanceDays + 1 }, (_, i) => {
    const at = new Date(now + i * 86400000)
    const [, month, day] = venueDateKey(at).split('-').map(Number)
    const weekday = WEEKDAYS[SHORT.indexOf(venueDay.format(at))] ?? ''
    const label = i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : weekday
    return { key: venueDateKey(at), label, date: `${month}/${day}` }
  })
}

/** pages/book: 选择时间 for a lesson type, before a coach or time is picked. */
export function BookScreen({
  catalog,
  lessonTypeId,
  now,
}: {
  catalog: CatalogData
  lessonTypeId: number
  now: Date
}) {
  const lessonType = catalog.lessonTypes.find((t) => t.id === lessonTypeId)
  if (!lessonType) return null
  const coaches = catalog.coaches.flatMap((c) => {
    const lesson = c.lessons.find((l) => l.lessonTypeId === lessonTypeId)
    return lesson ? [{ ...c, ...priceText(lesson.price) }] : []
  })
  const picked = coaches.length === 1 ? coaches[0] : undefined
  const days = bookableDays(lessonType.rules.advanceDays, now.getTime())
  return (
    <div>
      <div className="header">
        <div className="section-title first">教练</div>
        <div className="coach-scroll mp-scroll-x">
          <div className="coach-row">
            {coaches.length > 1 && (
              <div className="coach coach-active">
                <div className="coach-any">全部</div>
                <div className="coach-name">不限教练</div>
              </div>
            )}
            {coaches.map((item) => (
              <div key={item.id} className={item === picked ? 'coach coach-active' : 'coach'}>
                <TAvatar image={item.avatarUrl} size="44px" />
                <div className="coach-name">{item.name}</div>
                <div className="coach-price">
                  <span>{item.price}</span>
                  {item.original && <span className="price-original">{item.original}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
        {picked ? (
          <div className="coach-info">
            {picked.category && (
              <div className="coach-info-tag">
                <TTag size="small" theme="primary" variant="light">
                  {picked.category}
                </TTag>
              </div>
            )}
            <span className="coach-info-title">{picked.title || picked.name}</span>
            <span className="coach-info-link">教练介绍</span>
            <TIcon name="chevron-right" size="16px" />
          </div>
        ) : (
          coaches.length > 1 && (
            <div className="coach-info">
              <span className="coach-info-title">{coaches.length} 位教练可选</span>
              <span className="coach-info-link">教练介绍</span>
              <TIcon name="chevron-right" size="16px" />
            </div>
          )
        )}
        <div className="day-scroll mp-scroll-x">
          <div className="day-row">
            {days.map((d, i) => (
              <div key={d.key} className={i === 0 ? 'day day-active' : 'day'}>
                <div className="day-label">{d.label}</div>
                <div className="day-date">{d.date}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="slots-empty">
        <TEmpty
          icon="time"
          size="56px"
          description={lessonType.capacity > 1 ? '这一天没有排课' : '这一天没有可预约的时段'}
        />
      </div>
    </div>
  )
}

/** pages/packages: 课时包, with `highlight` outlined as when a banner opens it. */
export function PackagesScreen({
  catalog,
  highlight,
}: {
  catalog: CatalogData
  highlight?: number
}) {
  const typeNames = new Map(catalog.lessonTypes.map((t) => [t.id, t.name]))
  const coachNames = new Map(catalog.coaches.map((c) => [c.id, c.name]))
  const products = catalog.packageProducts.map((p) => {
    const coaches = p.coachIds.map((id) => coachNames.get(id)).filter(Boolean)
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      lessonCount: p.lessonCount,
      validity: `购买后 ${p.validityDays} 天内有效`,
      scope: `${typeNames.get(p.lessonTypeId) ?? ''} · ${coaches.length ? `限${coaches.join('、')}` : '全部教练'}`,
      price: yuan(p.price.price),
      original: p.price.originalPrice == null ? '' : yuan(p.price.originalPrice),
      unit: `¥${formatYuan(Math.round(p.price.price / Math.max(1, p.lessonCount)))}/节`,
      highlighted: p.id === highlight,
    }
  })
  if (!products.length) {
    return (
      <div className="centered">
        <TEmpty icon="wallet" size="56px" description="暂无在售的课时包" />
      </div>
    )
  }
  return (
    <div className="list">
      {products.map((item) => (
        <div
          key={item.id}
          className={`product card${item.highlighted ? ' product-highlight' : ''}`}
          {...(item.highlighted ? FOCUS : {})}
        >
          <div className="product-head">
            <div className="product-name">{item.name}</div>
            {item.original && (
              <div>
                <TTag size="small" theme="warning" variant="light">
                  限时优惠
                </TTag>
              </div>
            )}
          </div>
          <div className="product-scope">{item.scope}</div>
          {item.description && <div className="product-desc">{item.description}</div>}
          <div className="product-meta">
            {item.lessonCount} 节 · {item.validity}
          </div>
          <div className="product-foot">
            <div className="grow">
              <span className="product-price">{item.price}</span>
              {item.original && <span className="price-original">{item.original}</span>}
              <div className="product-unit">{item.unit}</div>
            </div>
            <TButton theme="primary">购买</TButton>
          </div>
        </div>
      ))}
      <div className="footnote">
        课时包仅限本人使用，过期后剩余课时将失效。未使用的课时可以申请退款，由场馆审核。
      </div>
    </div>
  )
}
