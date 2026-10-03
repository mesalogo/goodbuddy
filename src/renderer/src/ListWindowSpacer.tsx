/**
 * Stand-ins for rows a windowed list did not mount (see use-list-window.ts).
 * The height is computed geometry, so it is the one inline style these lists
 * carry; everything else stays in classes.
 */
export function ListWindowTableSpacer({ height, columns, className }: {
  height: number
  columns: number
  className?: string
}): React.JSX.Element {
  return (
    <tr aria-hidden="true" className={className}>
      <td colSpan={columns} style={{ height: `${height}px` }} />
    </tr>
  )
}
