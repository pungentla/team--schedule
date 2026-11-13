'use strict';

const express = require('express');
const db = require('../db/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { addDays, dateRange, diffDays, isDateString, nowIso, weekday } = require('../utils/date');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const { intParam, requireInt, requireString, requireArray, requireTime, optionalInt } = require('../utils/validate');

const router = express.Router();
const isAdmin = user => ['admin', 'super_admin'].includes(user.role);
const eventFields = 'e.id, e.title, e.starts_at AS startsAt, e.ends_at AS endsAt';
const requireMemberIds = (value, min = 1) => [...new Set(requireArray(value, '人员名单', { min })
  .map(id => requireInt(id, '人员编号', { min: 1, max: Number.MAX_SAFE_INTEGER })))];
const memberStatus = (member, endsAt, now) => member.checkedInAt ? 'present' : endsAt <= now ? 'absent' : 'pending';
const shanghaiDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

router.use(requireAuth, (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/', (req, res) => {
  const userId = req.user.id;
  const events = isAdmin(req.user)
    ? db.all(`SELECT ${eventFields}, COUNT(m.user_id) AS expected, COUNT(m.checked_in_at) AS attended,
        MAX(CASE WHEN m.user_id = ? THEN 1 ELSE 0 END) AS isMember,
        MAX(CASE WHEN m.user_id = ? THEN m.checked_in_at END) AS checkedInAt
      FROM attendance_events e JOIN attendance_members m ON m.event_id = e.id
      GROUP BY e.id ORDER BY e.starts_at DESC, e.id DESC`, userId, userId)
    : db.all(`SELECT ${eventFields}, 1 AS isMember, m.checked_in_at AS checkedInAt
      FROM attendance_members m JOIN attendance_events e ON e.id = m.event_id
      WHERE m.user_id = ? ORDER BY e.starts_at DESC, e.id DESC`, userId);
  res.json({ data: events });
});

function validateInstant(value, label) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw badRequest(`${label}格式无效`);
  return value;
}

function validateNewMembers(memberIds) {
  if (!memberIds.length) return;
  const count = db.pluck(`SELECT COUNT(*) FROM users
    WHERE status = 'active' AND role <> 'super_admin' AND id IN (SELECT value FROM json_each(?))`, JSON.stringify(memberIds));
  if (count !== memberIds.length) throw badRequest('名单中有不可参与签到的人员，请重新选择');
}

function singleWindow(body, now) {
  const startsAt = validateInstant(body.startsAt, '开始时间');
  const endsAt = validateInstant(body.endsAt, '结束时间');
  if (endsAt <= startsAt) throw badRequest('结束时间必须晚于开始时间');
  if (endsAt <= now) throw badRequest('结束时间必须晚于当前时间');
  return [{ startsAt, endsAt }];
}

function weeklyWindows(repeat, now) {
  const { startDate, endDate } = repeat;
  if (!isDateString(startDate) || !isDateString(endDate) || endDate < startDate) throw badRequest('请选择有效的日期范围');
  if (diffDays(startDate, endDate) >= 366) throw badRequest('一次批量发布最多覆盖 366 天');
  const days = new Set(requireArray(repeat.weekdays, '每周签到日', { min: 1, max: 7 })
    .map(day => requireInt(day, '星期', { min: 0, max: 6 })));
  const startTime = requireTime(repeat.startTime, '每日开始时间');
  const endTime = requireTime(repeat.endTime, '每日结束时间');
  if (endTime <= startTime) throw badRequest('每日结束时间必须晚于当天的开始时间');
  const windows = dateRange(startDate, endDate).filter(date => days.has(weekday(date))).map(date => ({
    date,
    startsAt: new Date(`${date}T${startTime}+08:00`).toISOString(),
    endsAt: new Date(`${date}T${endTime}+08:00`).toISOString(),
  })).filter(window => window.endsAt > now);
  if (!windows.length) throw badRequest('所选范围内没有可发布的签到日期');
  return windows;
}

router.post('/', requireAdmin, (req, res) => {
  const body = req.body || {};
  const title = requireString(body.title, '活动名称', { max: 80 });
  const now = nowIso();
  const batch = body.repeat !== undefined;
  if (batch && (!body.repeat || typeof body.repeat !== 'object' || Array.isArray(body.repeat))) {
    throw badRequest('请填写批量发布规则');
  }
  const windows = batch ? weeklyWindows(body.repeat, now) : singleWindow(body, now);
  const memberIds = requireMemberIds(body.memberIds);
  const ids = db.tx(() => {
    validateNewMembers(memberIds);
    const existing = batch ? new Set(db.all(`SELECT starts_at, ends_at FROM attendance_events
      WHERE title = ? AND starts_at BETWEEN ? AND ?`, title, windows[0].startsAt, windows.at(-1).startsAt)
      .map(event => `${event.starts_at}|${event.ends_at}`)) : null;
    const duplicate = existing && windows.find(({ startsAt, endsAt }) => existing.has(`${startsAt}|${endsAt}`));
    if (duplicate) throw conflict('ATTENDANCE_DUPLICATE', `${duplicate.date} 已有同名且同时间的签到活动，请调整日期范围或活动名称`);

    return windows.map(({ startsAt, endsAt }) => {
      const { lastInsertRowid } = db.run('INSERT INTO attendance_events (title, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
        title, startsAt, endsAt, req.user.id, now);
      db.run('INSERT INTO attendance_members (event_id, user_id) SELECT ?, value FROM json_each(?)', lastInsertRowid, JSON.stringify(memberIds));
      return lastInsertRowid;
    });
  });
  res.status(201).json({ data: batch ? { ids, count: ids.length } : { id: ids[0] } });
});

router.get('/people/:userId', (req, res) => {
  const allPeople = req.params.userId === 'all';
  const userId = allPeople ? null : intParam(req.params.userId, '人员编号');
  if (userId !== req.user.id && !isAdmin(req.user)) throw forbidden('只能查看自己的出勤');
  if (!allPeople && !db.get('SELECT id FROM users WHERE id = ?', userId)) throw notFound('人员不存在');
  const days = optionalInt(req.query.days, '天数', { min: 1, max: 365 }) ?? 30;
  const now = new Date();
  const endDate = shanghaiDate.format(now);
  const startDate = addDays(endDate, 1 - days);
  const from = new Date(`${startDate}T00:00:00+08:00`).toISOString();
  if (allPeople) {
    const events = db.all(`SELECT ${eventFields}, COUNT(*) AS expected, COUNT(m.checked_in_at) AS attended,
        MAX(CASE WHEN m.user_id = ? THEN 1 ELSE 0 END) AS isMember,
        MAX(CASE WHEN m.user_id = ? THEN m.checked_in_at END) AS checkedInAt
      FROM attendance_events e JOIN attendance_members m ON m.event_id = e.id
      WHERE e.ends_at BETWEEN ? AND ?
      GROUP BY e.id ORDER BY e.ends_at DESC, e.id DESC`, req.user.id, req.user.id, from, now.toISOString());
    const expected = events.reduce((total, event) => total + event.expected, 0);
    const attended = events.reduce((total, event) => total + event.attended, 0);
    return res.json({ data: { startDate, endDate, expected, attended, events } });
  }
  const events = db.all(`SELECT ${eventFields}, m.checked_in_at AS checkedInAt,
      (SELECT COUNT(*) FROM attendance_members roster WHERE roster.event_id = e.id) AS expected,
      (SELECT COUNT(roster.checked_in_at) FROM attendance_members roster WHERE roster.event_id = e.id) AS attended
    FROM attendance_members m JOIN attendance_events e ON e.id = m.event_id
    WHERE m.user_id = ? AND e.ends_at >= ? AND e.ends_at <= ?
    ORDER BY e.ends_at DESC, e.id DESC`, userId, from, now.toISOString());
  const attended = events.filter(event => event.checkedInAt).length;
  res.json({ data: { startDate, endDate, expected: events.length, attended, events } });
});

router.get('/:id', requireAdmin, (req, res) => {
  const id = intParam(req.params.id, '活动编号');
  const event = db.get(`SELECT ${eventFields} FROM attendance_events e WHERE e.id = ?`, id);
  if (!event) throw notFound('签到活动不存在');
  const now = nowIso();
  const members = db.all(`SELECT u.id AS userId, u.display_name AS name, u.employee_no AS employeeNo,
      m.checked_in_at AS checkedInAt, actor.display_name AS checkedInByName
    FROM attendance_members m JOIN users u ON u.id = m.user_id
    LEFT JOIN users actor ON actor.id = m.checked_in_by WHERE m.event_id = ? ORDER BY u.employee_no`, id)
    .map(member => ({ ...member, status: memberStatus(member, event.endsAt, now) }));
  res.json({ data: { ...event, members } });
});

router.patch('/:id/members', requireAdmin, (req, res) => {
  const id = intParam(req.params.id, '活动编号');
  const add = requireMemberIds(req.body?.add ?? [], 0);
  const remove = requireMemberIds(req.body?.remove ?? [], 0);
  const removeIds = new Set(remove);
  if (add.some(userId => removeIds.has(userId))) throw badRequest('同一人员不能同时新增和移除');
  const result = db.tx(() => {
    if (!db.get('SELECT id FROM attendance_events WHERE id = ?', id)) throw notFound('签到活动不存在');
    const current = new Map(db.all('SELECT user_id, checked_in_at FROM attendance_members WHERE event_id = ?', id)
      .map(member => [member.user_id, member.checked_in_at]));
    const toAdd = add.filter(userId => !current.has(userId));
    const toRemove = remove.filter(userId => current.has(userId));
    if (toRemove.some(userId => current.get(userId))) {
      throw conflict('ATTENDANCE_ALREADY_CHECKED_IN', '部分人员已签到，请刷新名单后重试');
    }
    validateNewMembers(toAdd);
    const total = current.size + toAdd.length - toRemove.length;
    if (total < 1 || total > 500) throw badRequest('应到人员须为 1 至 500 人');
    db.run(`DELETE FROM attendance_members WHERE event_id = ? AND checked_in_at IS NULL
      AND user_id IN (SELECT value FROM json_each(?))`, id, JSON.stringify(toRemove));
    db.run('INSERT INTO attendance_members (event_id, user_id) SELECT ?, value FROM json_each(?)', id, JSON.stringify(toAdd));
    return { added: toAdd.length, removed: toRemove.length, expected: total };
  });
  res.json({ data: result });
});

router.put('/:id/proxy-check-in', requireAdmin, (req, res) => {
  const id = intParam(req.params.id, '活动编号');
  const memberIds = requireMemberIds(req.body?.memberIds);
  const now = nowIso();
  const result = db.tx(() => {
    const event = db.get('SELECT starts_at FROM attendance_events WHERE id = ?', id);
    if (!event) throw notFound('签到活动不存在');
    if (now < event.starts_at) throw conflict('ATTENDANCE_NOT_OPEN', '活动开始后才可以代签到');

    const members = JSON.stringify(memberIds);
    const matches = db.pluck(`SELECT COUNT(*) FROM attendance_members
      WHERE event_id = ? AND user_id IN (SELECT value FROM json_each(?))`, id, members);
    if (matches !== memberIds.length) throw badRequest('只能为该活动的应到人员代签到');

    const { changes } = db.run(`UPDATE attendance_members SET checked_in_at = ?, checked_in_by = ?
      WHERE event_id = ? AND checked_in_at IS NULL AND user_id IN (SELECT value FROM json_each(?))`,
    now, req.user.id, id, members);
    return { checkedIn: changes, alreadyCheckedIn: memberIds.length - changes };
  });
  res.json({ data: result });
});

router.put('/:id/check-in', (req, res) => {
  if (req.user.role === 'super_admin') throw forbidden('超级管理员仅管理签到活动');
  const id = intParam(req.params.id, '活动编号');
  const checkedInAt = db.tx(() => {
    const row = db.get(`SELECT e.starts_at, e.ends_at, m.checked_in_at FROM attendance_members m
      JOIN attendance_events e ON e.id = m.event_id WHERE m.event_id = ? AND m.user_id = ?`, id, req.user.id);
    if (!row) throw notFound('没有可签到的活动');
    if (row.checked_in_at) return row.checked_in_at;
    const now = nowIso();
    if (now < row.starts_at) throw conflict('ATTENDANCE_NOT_OPEN', '签到尚未开始');
    if (now >= row.ends_at) throw conflict('ATTENDANCE_CLOSED', '签到已结束');
    db.run('UPDATE attendance_members SET checked_in_at = ? WHERE event_id = ? AND user_id = ?', now, id, req.user.id);
    return now;
  });
  res.json({ data: { checkedInAt } });
});

module.exports = router;
