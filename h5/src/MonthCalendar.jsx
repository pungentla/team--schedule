import React from 'react';
import Button from 'antd/es/button';
import { dayjs, iso, monthOf } from './shared';

export function MonthCalendar({ month, startDate, endDate, move, selected, pick, blocked, dayInfo }) {
  const first = dayjs(month + '-01');
  const offset = (first.day() + 6) % 7;
  return <><div className="calendar-heading">
    <Button disabled={month <= monthOf(startDate)} onClick={() => move(first.subtract(1, 'month').format('YYYY-MM'))}>上个月</Button>
    <strong>{first.format('YYYY 年 M 月')}</strong>
    <Button disabled={month >= monthOf(endDate)} onClick={() => move(first.add(1, 'month').format('YYYY-MM'))}>下个月</Button>
  </div><div className="calendar-grid">
    {[...'一二三四五六日'].map(w => <span className="muted" key={w}>周{w}</span>)}
    {Array.from({ length: offset }, (_, i) => <span key={`blank${i}`} />)}
    {Array.from({ length: first.daysInMonth() }, (_, i) => {
      const value = first.add(i, 'day');
      const date = iso(value);
      const disabled = blocked(value);
      const info = dayInfo(date);
      return <Button key={date} className="calendar-date" type={date === selected ? 'primary' : 'default'} disabled={disabled}
        aria-label={info ? `${date}，${info.label}` : date} aria-pressed={date === selected} onClick={() => pick(date)}>
        <span>{i + 1}</span>{info?.badge}
      </Button>;
    })}
  </div></>;
}
