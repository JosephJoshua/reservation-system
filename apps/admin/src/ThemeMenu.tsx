import { useCallback, useRef, useState } from 'react'
import { CheckIcon, ContrastIcon, MoonIcon, SunnyIcon } from 'tdesign-icons-react'
import { Button, Popup } from 'tdesign-react'
import { setThemeChoice, type ThemeChoice, useThemeChoice } from './theme'

const choices = {
  system: { label: '跟随系统', icon: ContrastIcon },
  light: { label: '浅色', icon: SunnyIcon },
  dark: { label: '深色', icon: MoonIcon },
} satisfies Record<ThemeChoice, { label: string; icon: typeof SunnyIcon }>

/** The header's 外观 button: follow the system, or force light or dark in this browser. */
export function ThemeMenu() {
  const choice = useThemeChoice()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const { label, icon: Icon } = choices[choice]
  // Stable, as a new attach function moves the popup and drops focus from the choice.
  const attach = useCallback(() => wrap.current ?? document.body, [])

  const close = () => {
    setOpen(false)
    wrap.current?.querySelector<HTMLButtonElement>('.theme-menu-button')?.focus()
  }

  return (
    <span ref={wrap} className="theme-menu-wrap">
      <Popup
        trigger="click"
        placement="bottom-right"
        showArrow={false}
        visible={open}
        onVisibleChange={setOpen}
        // Next to the button, so Tab goes from it to the choices.
        attach={attach}
        overlayInnerClassName="theme-menu"
        content={
          <fieldset
            className="theme-menu-choices"
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
            }}
            // Tabbing past the last choice closes the menu.
            onBlur={(e) => {
              if (e.relatedTarget && !wrap.current?.contains(e.relatedTarget)) setOpen(false)
            }}
          >
            <legend className="theme-menu-title">外观</legend>
            {(Object.keys(choices) as ThemeChoice[]).map((value) => {
              const item = choices[value]
              return (
                <button
                  key={value}
                  type="button"
                  className="theme-menu-item"
                  aria-pressed={value === choice}
                  onClick={() => {
                    setThemeChoice(value)
                    close()
                  }}
                >
                  <item.icon />
                  <span>{item.label}</span>
                  {value === choice && <CheckIcon className="theme-menu-check" />}
                </button>
              )
            })}
          </fieldset>
        }
      >
        <Button
          variant="text"
          shape="square"
          className="theme-menu-button"
          aria-label={`外观：${label}`}
          aria-expanded={open}
          title="外观"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && open) close()
          }}
        >
          <Icon size="20px" />
        </Button>
      </Popup>
    </span>
  )
}
