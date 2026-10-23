import type { ReactNode } from 'react'

/** A labelled form row. TDesign's FormItem takes over its child's value, so plain rows are used. */
export function Field({
  label,
  help,
  children,
}: {
  label?: string
  help?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-body">
        {children}
        {help && <div className="field-help">{help}</div>}
      </div>
    </div>
  )
}
