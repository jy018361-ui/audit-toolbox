export function documentsByRequestedOrder<T extends { id: string }>(
  documents: T[],
  requestedIds: string[],
): T[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const seen = new Set<string>();
  return requestedIds.flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const document = byId.get(id);
    return document ? [document] : [];
  });
}
