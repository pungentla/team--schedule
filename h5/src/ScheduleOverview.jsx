import React, { useState } from 'react';
import Card from 'antd/es/card';
import { Heading, dayjs, group, iso, shiftText } from './shared';

function trendBuckets(assignments, startDate, endDate, weekdays) {
  const start = dayjs(startDate);
  const end = dayjs(endDate);
  const days = end.diff(start, 'day') + 1;
  const monthly = days > 84;
  const interval = days > 14 ? 7 : 1;
  const counts = new Map(group(assignments, a => a.workDate).map(([date, items]) => [date, items.length]));
  const buckets = [];
  for (let day = start; !day.isAfter(end, 'day');) {
    const next = monthly ? day.startOf('month').add(1, 'month') : day.add(interval, 'day');
    const last = next.isAfter(end) ? end : next.subtract(1, 'day');
    let count = 0;
    let includesWeekday = false;
    for (let date = day; !date.isAfter(last, 'day'); date = date.add(1, 'day')) {
      if (!weekdays.includes(date.day())) continue;
      includesWeekday = true;
      count += counts.get(iso(date)) || 0;
    }
    if (includesWeekday) {
      const from = iso(day), to = iso(last);
      buckets.push({ key: from, date: from === to ? from : `${from} 至 ${to}`, count });
    }
    day = next;
  }
  return buckets;
}

function ScheduleTrend({ assignments, startDate, endDate, weekdays }) {
  const buckets = trendBuckets(assignments, startDate, endDate, weekdays);
  const [selectedKey, select] = useState(null);
  const selected = buckets.find(bucket => bucket.key === selectedKey) || buckets.find(bucket => bucket.count > 0) || buckets[0];
  if (!selected) return null;
  const peak = Math.max(...buckets.map(bucket => bucket.count), 1);
  return <section aria-label="排班趋势">
    <h3>排班趋势</h3>
    <div className="muted chart-selection" aria-live="polite">{selected.date} · {selected.count} 人次</div>
    <div className="schedule-trend" role="group" aria-label="按日期查看排班人次">
      {buckets.map(bucket => <button key={bucket.key} type="button" aria-pressed={bucket.key === selected.key}
        aria-label={`${bucket.date}，${bucket.count} 人次`} onClick={() => select(bucket.key)}>
        <span style={{ height: `${bucket.count / peak * 100}%` }} />
      </button>)}
    </div>
    <div className="row-between muted"><span>{dayjs(startDate).format('M/D')}</span><span>{dayjs(endDate).format('M/D')}</span></div>
  </section>;
}

function ScheduleBreakdown({ assignments, byShift }) {
  const rows = group(assignments, byShift ? a => shiftText(a) : a => a.workTypeId)
    .map(([key, items]) => ({ key, label: byShift ? key : items[0].workTypeName, count: items.length }))
    .sort((a, b) => b.count - a.count);
  const visible = rows.slice(0, 5);
  if (rows.length > 5) visible.push({ key: 'other', label: byShift ? '其他班次' : '其他工作', count: rows.slice(5).reduce((sum, row) => sum + row.count, 0) });
  const peak = Math.max(...visible.map(row => row.count));
  const title = byShift ? '班次分布' : '工作分布';
  return <section aria-label={title}>
    <h3>{title}</h3>
    <ul className="schedule-breakdown">
      {visible.map(row => <li key={row.key}>
        <div className="row-between"><span>{row.label}</span><span className="muted">{row.count} 人次</span></div>
        <div className="schedule-breakdown-track" aria-hidden="true"><span style={{ width: `${row.count / peak * 100}%` }} /></div>
      </li>)}
    </ul>
  </section>;
}

export function ScheduleOverview({ assignments, startDate, endDate, scope, weekdays }) {
  const distinct = field => new Set(assignments.map(a => a[field])).size;
  const stats = [
    ['排班人次', assignments.length],
    ['排班天数', distinct('workDate')],
    scope === 'mine' ? ['涉及工作', distinct('workTypeId')] : ['参与人数', distinct('userId')],
  ];
  return <Card className="schedule-overview">
    <Heading>排班概览</Heading>
    <dl className="schedule-stats">{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {!!assignments.length && <div className="schedule-charts">
      <ScheduleTrend key={`${startDate}:${endDate}:${weekdays.join(',')}`} assignments={assignments} startDate={startDate} endDate={endDate} weekdays={weekdays} />
      <ScheduleBreakdown assignments={assignments} byShift={scope === 'work'} />
    </div>}
  </Card>;
}
