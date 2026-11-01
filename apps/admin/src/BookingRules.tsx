import type { BookingRules, RuleName, RuleOverrides } from '@rs/shared'
import { ruleLabels, ruleLimits, ruleNames, ruleText } from '@rs/shared'
import type { ReactNode } from 'react'
import { Button, Radio, Tag } from 'tdesign-react'
import { Field } from './Field'
import { typedNumber } from './format'
import { NumberBox } from './NumberBox'

const HELP: Partial<Record<RuleName, string>> = {
  advanceDays: '学员可以预约从今天起多少天内的课',
  minNoticeMinutes: '距离课程开始不足这个时间时，就不能再预约',
  cancelDeadlineHours: '课程开始前超过这个时间取消的，全额退款或退回课时',
  studentMoves: '在免费取消截止前，学员每节课可以自行改约的次数。填 0 则不允许改约',
}

/** A rule added to the shared schema but not here fails typecheck at its switch. */
function unknownRule(name: never): never {
  throw new Error(`unknown booking rule ${name}`)
}

/** A typed whole number, or null to keep the last one. */
function typedRule(v: unknown) {
  const n = typedNumber(v)
  return n === null ? null : Math.floor(n)
}

/** A number rule's input. 最晚预约 is kept in minutes and typed in hours. */
function NumberRule({
  name,
  value,
  suffix,
  onChange,
}: {
  name: keyof typeof ruleLimits
  value: number
  suffix: string
  onChange: (v: number) => void
}) {
  const limits = ruleLimits[name]
  if (name === 'minNoticeMinutes') {
    return (
      <NumberBox
        theme="normal"
        value={value / 60}
        min={limits.min / 60}
        max={limits.max / 60}
        decimalPlaces={1}
        suffix={suffix}
        onChange={(v) => {
          const hours = typedNumber(v)
          if (hours !== null) onChange(Math.round(hours * 60))
        }}
      />
    )
  }
  return (
    <NumberBox
      theme="normal"
      value={value}
      min={limits.min}
      max={limits.max}
      suffix={suffix}
      onChange={(v) => {
        const n = typedRule(v)
        if (n !== null) onChange(n)
      }}
    />
  )
}

/** The input for one rule. */
function RuleInput({
  name,
  value,
  onChange,
}: {
  name: RuleName
  value: BookingRules[RuleName]
  onChange: (v: BookingRules[RuleName]) => void
}): ReactNode {
  switch (name) {
    case 'advanceDays':
      return <NumberRule name={name} value={value as number} suffix="天" onChange={onChange} />
    case 'minNoticeMinutes':
      return <NumberRule name={name} value={value as number} suffix="小时" onChange={onChange} />
    case 'cancelDeadlineHours':
      return <NumberRule name={name} value={value as number} suffix="小时" onChange={onChange} />
    case 'studentMoves':
      return <NumberRule name={name} value={value as number} suffix="次" onChange={onChange} />
    case 'lateCancel': {
      const late = value as BookingRules['lateCancel']
      return (
        <div className="stack">
          <Radio.Group
            value={late.kind}
            onChange={(v) =>
              onChange(v === 'forfeit' ? { kind: 'forfeit' } : { kind: 'partial', percent: 50 })
            }
          >
            <Radio value="forfeit">视为已上课，不退款，也不退回课时</Radio>
            <Radio value="partial">按比例退款</Radio>
          </Radio.Group>
          {late.kind === 'partial' && (
            <>
              <NumberBox
                theme="normal"
                value={late.percent}
                min={0}
                max={100}
                suffix="%"
                onChange={(v) => {
                  const percent = typedRule(v)
                  if (percent !== null) onChange({ kind: 'partial', percent })
                }}
              />
              <span className="muted">用课时包预约的课，只有比例为 100% 时才会退回课时</span>
            </>
          )}
        </div>
      )
    }
    default:
      return unknownRule(name)
  }
}

/** The venue's 默认预约规则, every rule set. */
export function DefaultRuleFields({
  value,
  onChange,
}: {
  value: BookingRules
  onChange: (patch: Partial<BookingRules>) => void
}) {
  return (
    <>
      {ruleNames.map((name) => (
        <Field key={name} label={ruleLabels[name]} help={HELP[name]}>
          <RuleInput name={name} value={value[name]} onChange={(v) => onChange({ [name]: v })} />
        </Field>
      ))}
    </>
  )
}

/**
 * A lesson type's rules: each one follows the venue's default until it is set on its own, and can
 * go back to it. `defaults` is null while the venue's rules load.
 */
export function RuleOverrideFields({
  value,
  defaults,
  onChange,
}: {
  value: RuleOverrides
  defaults: BookingRules | null
  onChange: (v: RuleOverrides) => void
}) {
  return (
    <>
      {ruleNames.map((name) => {
        const own = value[name]
        const fallback = defaults?.[name]
        if (own === undefined) {
          return (
            <Field key={name} label={ruleLabels[name]}>
              <div className="rule-default">
                <span className="field-text muted-strong">
                  {fallback === undefined ? '跟随默认' : `跟随默认：${ruleText(name, fallback)}`}
                </span>
                <Button
                  variant="text"
                  theme="primary"
                  disabled={fallback === undefined}
                  onClick={() => fallback !== undefined && onChange({ ...value, [name]: fallback })}
                >
                  单独设置
                </Button>
              </div>
            </Field>
          )
        }
        return (
          <Field key={name} label={ruleLabels[name]} help={HELP[name]}>
            <RuleInput
              name={name}
              value={own as BookingRules[typeof name]}
              onChange={(v) => onChange({ ...value, [name]: v })}
            />
            <div className="rule-own">
              <Tag theme="primary" variant="light" size="small">
                已单独设置
              </Tag>
              {fallback !== undefined && (
                <span className="muted">默认：{ruleText(name, fallback)}</span>
              )}
              <Button
                variant="text"
                theme="primary"
                size="small"
                onClick={() => {
                  const { [name]: _, ...rest } = value
                  onChange(rest)
                }}
              >
                恢复默认
              </Button>
            </div>
          </Field>
        )
      })}
    </>
  )
}
