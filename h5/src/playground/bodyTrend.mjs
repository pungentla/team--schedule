export function bodyTrend(records, field) {
  const values = records.filter(row => Number.isFinite(row[field])).map(row => ({ date: row.date, value: row[field] })).sort((a, b) => a.date.localeCompare(b.date));
  if (!values.length) return null;
  const numbers = values.map(row => row.value), min = Math.min(...numbers), max = Math.max(...numbers);
  const padding = Math.max(0.5, (max - min) * 0.15);
  const low = Math.max(0, Math.floor((min - padding) * 10) / 10), high = Math.ceil((max + padding) * 10) / 10;
  const firstDay = Date.parse(values[0].date + 'T00:00:00Z'), lastDay = Date.parse(values.at(-1).date + 'T00:00:00Z');
  return { low, high, first: values[0], last: values.at(-1), change: Math.round((values.at(-1).value - values[0].value) * 10) / 10,
    points: values.map(row => ({ ...row, x: firstDay === lastDay ? 315 : 50 + (Date.parse(row.date + 'T00:00:00Z') - firstDay) / (lastDay - firstDay) * 530, y: 150 - (row.value - low) / (high - low) * 130 })),
  };
}
