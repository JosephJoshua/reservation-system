import { useRef, useState } from 'react'
import { InputNumber, type InputNumberProps } from 'tdesign-react'

/**
 * A number box that never fills itself in: emptied and left, it shows its last value again
 * rather than dropping to the minimum, and a number past a limit comes back to it on leaving.
 */
export function NumberBox({ onChange, onBlur, ...props }: InputNumberProps) {
  const emptied = useRef(false)
  // A new box shows the value it is given, where TDesign's would keep showing it empty.
  const [round, setRound] = useState(0)
  const restore = () => {
    emptied.current = false
    setRound((r) => r + 1)
  }
  return (
    <InputNumber
      key={round}
      {...props}
      allowInputOverLimit={false}
      onChange={(v, ctx) => {
        if (v === '' || v === undefined || v === null || Number.isNaN(Number(v))) {
          emptied.current = true
          return
        }
        // TDesign raises an emptied box to its minimum when it is left.
        if (ctx.type === 'blur' && emptied.current) return restore()
        emptied.current = false
        onChange?.(v, ctx)
      }}
      onBlur={(v, ctx) => {
        if (emptied.current) restore()
        onBlur?.(v, ctx)
      }}
    />
  )
}
