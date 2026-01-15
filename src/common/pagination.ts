export type PaginationQuery = {
  limit?: string;
  cursor?: string;
};

export type PaginationResult = {
  take: number;
  skip: number;
  cursor?: { id: string };
};

export type PaginatedResponse<T> = {
  items: T[];
  nextCursor: string | null;
  total?: number;
};

export function parsePagination(
  query: PaginationQuery,
  defaultLimit = 25,
  maxLimit = 100,
): PaginationResult {
  const limit = Math.min(
    Math.max(parseInt(query.limit ?? `${defaultLimit}`, 10), 1),
    maxLimit,
  );
  const cursor = query.cursor ? { id: query.cursor } : undefined;
  return { take: limit, skip: cursor ? 1 : 0, cursor };
}

export function buildPaginatedResponse<T extends { id: string }>(
  items: T[],
  limit: number,
  total?: number,
): PaginatedResponse<T> {
  const nextCursor =
    items.length >= limit ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor, total };
}
