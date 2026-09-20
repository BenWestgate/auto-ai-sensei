export function sortOgsGamesOldestFirst(games) {
  return [...games].sort((a, b) => {
    const at = Date.parse(a?.ended ?? '') || 0;
    const bt = Date.parse(b?.ended ?? '') || 0;
    return at - bt || Number(a?.id ?? 0) - Number(b?.id ?? 0);
  });
}
