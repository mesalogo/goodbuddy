export function selectMagicNotePages(pages, limit = 1) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
    throw new RangeError('Canvas analysis page count must be an integer from 1 to 8');
  }
  return pages.slice(0, limit);
}
