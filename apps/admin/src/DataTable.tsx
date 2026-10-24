import { Button, Table, type TableProps, type TableRowData } from 'tdesign-react'

// Columns of row buttons. On a phone they become the card's footer instead of a labelled row.
const ACTION_COLUMNS = new Set(['op', 'actions'])

/**
 * A TDesign table that becomes a list of cards on a phone: the first column is the card's title,
 * the others show their column title beside the value, and row buttons sit in a footer. Each
 * cell's content is wrapped in one element, so phone.css can line the label up with its first
 * line whatever the cell holds.
 */
export function DataTable<T extends TableRowData>(props: TableProps<T>) {
  const columns = props.columns?.map((c) => {
    const cell = c.cell
    const wrapped =
      typeof cell === 'function'
        ? { cell: (ctx: Parameters<typeof cell>[0]) => <div className="cell">{cell(ctx)}</div> }
        : {}
    if (typeof c.attrs === 'function') return { ...c, ...wrapped }
    return {
      ...c,
      ...wrapped,
      attrs: {
        'data-label': typeof c.title === 'string' ? c.title : '',
        ...(ACTION_COLUMNS.has(String(c.colKey)) ? { 'data-actions': '' } : {}),
        ...c.attrs,
      },
    }
  })
  return (
    <Table
      {...props}
      columns={columns}
      className={props.className ? `card-table ${props.className}` : 'card-table'}
    />
  )
}

/** The button under a paged list, with how many rows are shown so far. */
export function LoadMore({
  shown,
  more,
  loading,
  onMore,
}: {
  shown: number
  more: boolean
  loading: boolean
  onMore: () => void
}) {
  if (shown === 0) return null
  return (
    <div className="load-more">
      {more ? (
        <Button variant="outline" loading={loading} onClick={onMore}>
          加载更多
        </Button>
      ) : (
        <span className="muted">共 {shown} 条</span>
      )}
    </div>
  )
}
