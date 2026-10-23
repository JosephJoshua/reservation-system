import type { Person } from './types'

/** A student in a table: name linking to their details, phone below. Long names are cut. */
export function StudentCell({ student }: { student: Person | null }) {
  if (!student) return <span className="muted">-</span>
  return (
    <div className="student-cell">
      <a href={`#/students?id=${student.id}`} title={student.name}>
        {student.name || '未填写'}
      </a>
      {student.phone && <div className="muted nowrap">{student.phone}</div>}
    </div>
  )
}
