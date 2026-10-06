/** Counts DTO memory without stringifying or copying its string/binary bodies. */
export function storageDataBytes(value: unknown, limit = 32 * 1024 * 1024): number {
  let bytes = 0
  const seen = new Set<object>()
  const visit = (item: unknown): void => {
    bytes += 16
    if (typeof item === 'string') bytes += item.length * 2
    else if (typeof item === 'function' || typeof item === 'symbol') throw new TypeError('Storage requires data, not callbacks or symbols')
    else if (item && typeof item === 'object') {
      if (seen.has(item)) return
      seen.add(item)
      if (item instanceof Uint8Array) bytes += item.byteLength
      else if (item instanceof Date) bytes += 8
      else if (item instanceof Map) for (const [key, entry] of item) { visit(key); visit(entry) }
      else if (item instanceof Set || Array.isArray(item)) for (const entry of item) visit(entry)
      else {
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
          throw new TypeError('Storage requires plain data, not live objects')
        }
        for (const key of Object.keys(item)) { visit(key); visit((item as Record<string, unknown>)[key]) }
      }
    }
    if (bytes > limit) throw Object.assign(new RangeError('Storage payload capacity exceeded; use a bounded domain batch or page'), { code: 'STORAGE_CAPACITY' })
  }
  visit(value)
  return bytes
}
