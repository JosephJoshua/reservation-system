import { Table, type TableProps, type TableRowData } from 'tdesign-react'

/**
 * A TDesign table that becomes a list of cards on a phone. Each cell carries its column title,
 * which phone.css shows as the label beside the value.
 */
export function DataTable<T extends TableRowData>(props: TableProps<T>) {
  const columns = props.columns?.map((c) =>
    typeof c.attrs === 'function'
      ? c
      : { ...c, attrs: { 'data-label': typeof c.title === 'string' ? c.title : '', ...c.attrs } },
  )
  return (
    <Table
      {...props}
      columns={columns}
      className={props.className ? `card-table ${props.className}` : 'card-table'}
    />
  )
}
