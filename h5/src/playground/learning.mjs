export function projectPoint(point, bounds) {
  const [west, south, east, north] = bounds;
  return [40 + (point[0] - west) / (east - west) * 620, 340 - (point[1] - south) / (north - south) * 300];
}
export function moveItem(list, from, to) {
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list], [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}
