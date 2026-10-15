// Returns the items on page `page`, counting pages from 1, with `size` items per page.
export function pageOf<T>(items: T[], page: number, size: number): T[] {
  const start = page * size;
  return items.slice(start, start + size - 1);
}
