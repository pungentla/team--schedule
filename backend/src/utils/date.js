'use strict';

/**
 * 日期工具 —— 全部基于 Asia/Shanghai 时区，避免 SQLite 的 UTC date('now') 在凌晨差一天。
 * 规则：所有"日期"以 'YYYY-MM-DD' 字符串传递；SQLite 只存不算。
 */

const TZ = process.env.TZ || 'Asia/Shanghai';

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const weekdayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'short',
});

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 是否为合法 YYYY-MM-DD */
function isDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 当前时区的今天 'YYYY-MM-DD' */
function today() {
  return dateFmt.format(new Date());
}

/** 当前时区时间 'HH:MM:SS' */
function nowTime() {
  return timeFmt.format(new Date());
}

/** 当前 ISO 时间戳（带 Z），用于 created_at */
function nowIso() {
  return new Date().toISOString();
}

/** 解析 'YYYY-MM-DD' 为 UTC 毫秒（仅用于纯日期算术，不受时区影响） */
function toUtcMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** UTC 毫秒转 'YYYY-MM-DD' */
function fromUtcMs(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 日期加减天数 */
function addDays(dateStr, days) {
  return fromUtcMs(toUtcMs(dateStr) + days * 86400000);
}

/** 两个日期间隔天数 (b - a) */
function diffDays(a, b) {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86400000);
}

/** 从开始日期计算含首尾的周期；月份不足时，结束日期取该月最后一天。 */
function periodEndDate(startDate, duration) {
  if (!isDateString(startDate)) throw new RangeError('无效的开始日期');
  if (duration === 'week') return addDays(startDate, 6);
  const months = { month: 1, bimonth: 2, quarter: 3, halfyear: 6, year: 12 }[duration];
  if (!months || !isDateString(startDate)) throw new RangeError('无效的周期或开始日期');
  const [year, month, day] = startDate.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUtcMs(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day === 1 ? 0 : Math.min(day - 1, lastDay)));
}

/** 是否 a <= d <= b */
function inRange(d, a, b) {
  return d >= a && d <= b;
}

/** 生成 [start, end] 之间的日期数组（含两端） */
function dateRange(start, end) {
  const out = [];
  if (end < start) return out;
  let cur = start;
  let guard = 0;
  while (cur <= end && guard < 1000) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
}

/** 星期几：0=周日 ... 6=周六 */
function weekday(dateStr) {
  const dt = new Date(toUtcMs(dateStr));
  return dt.getUTCDay();
}

/** 中文星期 */
function weekdayCn(dateStr) {
  return ['日', '一', '二', '三', '四', '五', '六'][weekday(dateStr)];
}

/** ISO 周键 'YYYY-Www'，用于每周上限统计 */
function isoWeekKey(dateStr) {
  const dt = new Date(toUtcMs(dateStr));
  // 移到本周四（ISO 周以周四归属年份）
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
  const weekNo = Math.ceil(((dt.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** 'HH:MM' 转分钟数，用于比较与时长计算 */
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** 时长（小时），支持跨零点（end < start 视为次日） */
function durationHours(startTime, endTime) {
  let diff = toMinutes(endTime) - toMinutes(startTime);
  if (diff <= 0) diff += 1440;
  return diff / 60;
}

/** 友好日期 'M月D日 周一' */
function friendlyDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}月${Number(d)}日 周${weekdayCn(dateStr)}`;
}

module.exports = {
  TZ,
  isDateString,
  today,
  nowTime,
  nowIso,
  addDays,
  diffDays,
  periodEndDate,
  inRange,
  dateRange,
  weekday,
  weekdayCn,
  isoWeekKey,
  toMinutes,
  durationHours,
  friendlyDate,
};
