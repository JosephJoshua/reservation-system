// The few TDesign Miniprogram components the previewed pages use, as React elements with the
// same class names, so TDesign's own wxss (see styles.ts) styles them. Icons are the matching
// TDesign SVGs instead of the mini program's icon font.
import type { ReactNode } from 'react'
import {
  CalendarIcon,
  CallIcon,
  ChevronRightIcon,
  ErrorCircleIcon,
  LocationIcon,
  SoundIcon,
  TimeIcon,
  UserIcon,
  WalletIcon,
} from 'tdesign-icons-react'

const icons = {
  calendar: CalendarIcon,
  call: CallIcon,
  'chevron-right': ChevronRightIcon,
  'error-circle': ErrorCircleIcon,
  location: LocationIcon,
  sound: SoundIcon,
  time: TimeIcon,
  user: UserIcon,
  wallet: WalletIcon,
}

export type IconName = keyof typeof icons

const cls = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ')

export function TIcon({
  name,
  size,
  className,
}: {
  name: IconName
  size?: string
  className?: string
}) {
  const Svg = icons[name]
  return (
    <div
      className={cls('mp-t-icon', 'mp-t-class', className)}
      style={size ? { fontSize: size } : undefined}
      aria-hidden
    >
      <Svg className="mp-icon-svg" />
    </div>
  )
}

export function TTag({
  size = 'medium',
  theme = 'default',
  variant = 'dark',
  children,
}: {
  size?: 'small' | 'medium'
  theme?: 'default' | 'primary' | 'warning'
  variant?: 'dark' | 'light' | 'outline'
  children: ReactNode
}) {
  return (
    <div
      className={cls(
        'mp-t-tag',
        `mp-t-tag--${theme}`,
        `mp-t-tag--${variant}`,
        `mp-t-tag--${size}`,
        'mp-t-tag--square',
      )}
    >
      <div className="mp-t-tag__icon" aria-hidden />
      <div className="mp-t-tag__text">{children}</div>
    </div>
  )
}

export function TAvatar({ image, size }: { image: string; size: string }) {
  return (
    <div className="mp-t-avatar__wrapper">
      <div className="mp-t-avatar t-avatar--circle" style={{ width: size, height: size }}>
        {image ? (
          <img
            className="mp-t-image t-avatar__image"
            src={image}
            alt=""
            style={{ objectFit: 'cover' }}
          />
        ) : (
          <TIcon name="user" className="mp-t-avatar__icon" />
        )}
      </div>
    </div>
  )
}

export function TButton({
  theme = 'default',
  size = 'medium',
  block,
  className,
  children,
}: {
  theme?: 'default' | 'primary' | 'light'
  size?: 'medium' | 'large'
  block?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cls(
        'mp-t-button',
        'mp-t-button--base',
        `mp-t-button--${theme}`,
        'mp-t-button--rectangle',
        `mp-t-button--size-${size}`,
        block && 'mp-t-button--block',
        className,
      )}
    >
      <div className="mp-t-button__content">{children}</div>
    </div>
  )
}

export function TCellGroup({ children }: { children: ReactNode }) {
  return <div className="mp-t-cell-group t-cell-group--card">{children}</div>
}

export function TCell({
  title,
  description,
  note,
  leftIcon,
  arrow,
  last,
}: {
  title: ReactNode
  description?: string
  note?: string
  leftIcon?: IconName
  arrow?: boolean
  /** TDesign leaves the border off the group's last cell. */
  last?: boolean
}) {
  return (
    <div className={cls('mp-t-cell', !last && 'mp-t-cell--bordered')}>
      <div className="mp-t-cell__left">
        {leftIcon && <TIcon name={leftIcon} className="mp-t-cell__left-icon" />}
      </div>
      <div className="mp-t-cell__title">
        <div className="mp-t-cell__title-text">{title}</div>
        <div className="mp-t-cell__description">
          {description && <div className="mp-t-cell__description-text">{description}</div>}
        </div>
      </div>
      <div className="mp-t-cell__note">{note && <span>{note}</span>}</div>
      <div className="mp-t-cell__right">
        {arrow && <TIcon name="chevron-right" className="mp-t-cell__right-icon" />}
      </div>
    </div>
  )
}

export function TNoticeBar({ content, marquee }: { content: string; marquee: boolean }) {
  return (
    <div className="mp-t-notice-bar t-notice-bar--info">
      <div className="mp-t-notice-bar__prefix-icon">
        <TIcon name="sound" />
      </div>
      <div className="mp-t-notice-bar__content-wrap">
        <div
          className={cls(
            'mp-t-notice-bar__content',
            !marquee && 'mp-t-notice-bar__content-wrapable',
            marquee && 'mp-marquee',
          )}
          // Roughly TDesign's 50px per second.
          style={
            marquee ? { animationDuration: `${Math.max(6, content.length * 0.35)}s` } : undefined
          }
        >
          {content}
        </div>
      </div>
    </div>
  )
}

export function TEmpty({
  icon,
  size,
  description,
}: {
  icon: IconName
  size: string
  description: string
}) {
  return (
    <div className="mp-t-empty">
      <div className="mp-t-empty__thumb" aria-hidden>
        <TIcon name={icon} size={size} className="mp-t-empty__icon" />
      </div>
      <div className="mp-t-empty__description">{description}</div>
      <div className="mp-t-empty__actions" />
    </div>
  )
}
