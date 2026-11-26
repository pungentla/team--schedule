'use strict';
const { createHash } = require('node:crypto');
const db = require('../db/db');
const harvest = require('./harvestService');
const catalog = require('../content/exercise-sports.json');
const { addDays, diffDays, isDateString, weekday } = require('../utils/date');
const { requireString, requireInt, requireEnum, requireBoolean, requireTime, requireArray } = require('../utils/validate');
const { badRequest, notFound, forbidden, conflict } = require('../utils/errors');
const { parseImage } = require('../utils/images');
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function dates(now = new Date()) {
  const today = dateFormat.format(now), weekStart = addDays(today, -((weekday(today) + 6) % 7));
  return { today, weekStart, weekEnd: addDays(weekStart, 6), earliestDate: addDays(today, -6) };
}
function settings(userId) {
  const row = db.get('SELECT weekly_goal AS weeklyGoal,reminder_enabled AS reminderEnabled,reminder_time AS reminderTime FROM exercise_settings WHERE user_id=?', userId);
  return row ? { ...row, reminderEnabled: !!row.reminderEnabled } : { weeklyGoal: 3, reminderEnabled: false, reminderTime: '20:30' };
}
function metadata(user, now = new Date()) {
  harvest.participant(user);
  const range = dates(now);
  return { ...range, settings: settings(user.id), catalog,
    customSports: db.all('SELECT category,sport_name AS name FROM exercise_records WHERE user_id=? AND is_custom=1 GROUP BY category,sport_name ORDER BY MAX(id) DESC LIMIT 30', user.id),
    todayCount: db.pluck('SELECT COUNT(*) FROM exercise_records WHERE user_id=? AND work_date=? AND deleted_at IS NULL', user.id, range.today),
    weekDays: db.all('SELECT DISTINCT work_date AS date FROM exercise_records WHERE user_id=? AND work_date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY work_date', user.id, range.weekStart, range.weekEnd).map(row => row.date),
    weekMinutes: db.pluck('SELECT COALESCE(SUM(minutes),0) FROM exercise_records WHERE user_id=? AND work_date BETWEEN ? AND ? AND deleted_at IS NULL', user.id, range.weekStart, range.weekEnd),
    firstDate: db.pluck('SELECT MIN(work_date) FROM exercise_records WHERE user_id=? AND deleted_at IS NULL', user.id) || range.today,
  };
}
function saveSettings(user, body) {
  harvest.participant(user);
  const goal = requireInt(body.weeklyGoal, '每周目标', { min: 1, max: 7 });
  const enabled = requireBoolean(body.reminderEnabled, '每日提醒');
  const time = requireTime(body.reminderTime, '提醒时间');
  return db.tx(() => {
    db.run(`INSERT INTO exercise_settings(user_id,weekly_goal,reminder_enabled,reminder_time) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET weekly_goal=excluded.weekly_goal,reminder_enabled=excluded.reminder_enabled,reminder_time=excluded.reminder_time`, user.id, goal, Number(enabled), time);
    db.run("DELETE FROM push_events WHERE user_id=? AND push_kind='exercise'", user.id);
    if (!enabled) db.run("UPDATE system_notices SET read_at=? WHERE user_id=? AND kind='exercise' AND read_at IS NULL", Date.now(), user.id);
    return settings(user.id);
  });
}
const recordSelect = `SELECT r.id,r.user_id AS userId,u.display_name AS name,r.category,r.sport_name AS sportName,
  r.is_custom AS isCustom,r.work_date AS date,r.minutes,r.note,r.visibility,r.created_at AS createdAt,
  (SELECT COUNT(*) FROM exercise_images i WHERE i.record_id=r.id) AS imageCount,
  (SELECT COUNT(*) FROM exercise_likes l WHERE l.record_id=r.id) AS likeCount,
  EXISTS(SELECT 1 FROM exercise_likes l WHERE l.record_id=r.id AND l.user_id=?1) AS liked
  FROM exercise_records r JOIN users u ON u.id=r.user_id`;
const publicCondition = "r.visibility='public' AND u.status='active' AND u.role IN ('employee','admin')";
function accessible(user, rawId) {
  harvest.participant(user);
  const id = requireInt(rawId, '记录', { min: 1 });
  const record = db.get(`${recordSelect} WHERE r.id=?2 AND r.deleted_at IS NULL AND (r.user_id=?1 OR (${publicCondition}))`, user.id, id);
  if (!record) throw notFound('运动记录不存在');
  return record;
}
function list(user, query = {}, now = new Date()) {
  harvest.participant(user);
  const scope = requireEnum(query.scope ?? 'mine', '查看范围', ['mine', 'public']);
  const visibility = requireEnum(query.visibility ?? 'all', '可见范围', ['all', 'private']);
  const page = requireInt(query.page ?? 1, '页码', { min: 1, max: 100000 });
  const month = requireString(query.month ?? dates(now).today.slice(0, 7), '月份', { max: 7 });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('月份无效');
  if (query.date && (!isDateString(query.date) || !query.date.startsWith(month))) throw badRequest('日期不属于当前月份');
  const params = [user.id];
  let condition = `r.deleted_at IS NULL AND ${scope === 'mine' ? 'r.user_id=?1' : publicCondition}`;
  if (scope === 'mine') {
    params.push(`${month}-%`); condition += ' AND r.work_date LIKE ?2';
    if (visibility === 'private') condition += " AND r.visibility='private'";
  }
  const days = scope === 'mine' ? db.all(`SELECT r.work_date AS date,COUNT(*) AS count,SUM(r.minutes) AS minutes FROM exercise_records r WHERE ${condition} GROUP BY r.work_date ORDER BY r.work_date`, ...params) : [];
  if (query.date && scope === 'mine') { params.push(query.date); condition += ` AND r.work_date=?${params.length}`; }
  const total = db.pluck(`SELECT COUNT(*) FROM exercise_records r JOIN users u ON u.id=r.user_id WHERE ${condition} AND ?1 IS NOT NULL`, ...params);
  const items = db.all(`${recordSelect} WHERE ${condition} ORDER BY r.work_date DESC,r.id DESC LIMIT 20 OFFSET ?${params.length + 1}`, ...params, (page - 1) * 20);
  return { items, total, page, pageSize: 20, days };
}
function create(user, body, now = new Date()) {
  harvest.participant(user);
  const requestKey = requireString(body.requestKey, '提交标识', { max: 80 });
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestKey)) throw badRequest('提交标识无效');
  const category = requireEnum(body.category, '运动分类', catalog.map(item => item.id));
  const sportName = requireString(typeof body.sportName === 'string' ? body.sportName.normalize('NFKC') : body.sportName, '运动项目', { max: 30 });
  if (/[\p{Cc}\p{Cf}]/u.test(sportName)) throw badRequest('运动项目包含无效字符');
  const isCustom = !catalog.find(item => item.id === category).sports.includes(sportName);
  const date = body.date;
  if (!isDateString(date)) throw badRequest('请选择有效的运动日期');
  const minutes = requireInt(body.minutes, '运动时长', { min: 1, max: 1440 });
  const note = requireString(body.note ?? '', '运动感受', { min: 0, max: 300 });
  const visibility = requireEnum(body.visibility ?? 'public', '可见范围', ['public', 'private']);
  const encoded = requireArray(body.images ?? [], '图片', { max: 3 });
  const images = encoded.map(parseImage);
  const hash = createHash('sha256').update(JSON.stringify({ category, sportName, date, minutes, note, visibility, encoded })).digest('hex');
  const range = dates(now);
  return db.tx(() => {
    const previous = db.get('SELECT id,request_hash,deleted_at FROM exercise_records WHERE user_id=? AND request_key=?', user.id, requestKey);
    if (previous) {
      if (previous.request_hash !== hash || previous.deleted_at) throw conflict('EXERCISE_REPLAY_CONFLICT', '这次打卡已提交，请刷新后重试');
      return { record: accessible(user, previous.id), replayed: true, reward: { amount: 0, reason: '已提交，不重复奖励', balance: harvest.balance(user.id) } };
    }
    if (date < range.earliestDate || date > range.today) throw badRequest('仅支持补记最近 7 天（含今天）的运动');
    const total = db.pluck('SELECT COALESCE(SUM(minutes),0) FROM exercise_records WHERE user_id=? AND work_date=? AND deleted_at IS NULL', user.id, date);
    if (total + minutes > 1440) throw badRequest('同一天的运动时长合计不能超过 1440 分钟');
    const { lastInsertRowid: id } = db.run(`INSERT INTO exercise_records(user_id,category,sport_name,is_custom,work_date,minutes,note,visibility,request_key,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, user.id, category, sportName, Number(isCustom), date, minutes, note, visibility, requestKey, hash, now.toISOString());
    images.forEach((image, i) => db.run('INSERT INTO exercise_images(record_id,position,mime_type,content) VALUES(?,?,?,?)', id, i + 1, image.mimeType, image.content));
    const reward = harvest.exercise(user.id, date, range.today);
    if (date === range.today) {
      db.run("DELETE FROM push_events WHERE user_id=? AND push_kind='exercise'", user.id);
      db.run("UPDATE system_notices SET read_at=? WHERE user_id=? AND kind='exercise' AND read_at IS NULL AND created_at>=?", now.getTime(), user.id, Date.parse(`${date}T00:00:00+08:00`));
    }
    return { record: accessible(user, id), reward, replayed: false };
  });
}
function remove(user, id) {
  const record = accessible(user, id);
  if (record.userId !== user.id) throw forbidden('只能删除自己的运动记录');
  db.tx(() => {
    db.run('UPDATE exercise_records SET deleted_at=? WHERE id=?', new Date().toISOString(), record.id);
    db.run('DELETE FROM exercise_images WHERE record_id=?', record.id);
    db.run('DELETE FROM exercise_likes WHERE record_id=?', record.id);
  });
  return { deleted: true };
}
function images(user, id) {
  const record = accessible(user, id);
  return db.all('SELECT position,mime_type,content FROM exercise_images WHERE record_id=? ORDER BY position', record.id)
    .map(row => ({ position: row.position, src: `data:${row.mime_type};base64,${Buffer.from(row.content).toString('base64')}` }));
}
function like(user, id, body) {
  const record = accessible(user, id), liked = requireBoolean(body.liked, '点赞');
  if (record.visibility !== 'public' || record.userId === user.id) throw badRequest('只能为其他人的公开记录点赞');
  if (liked) db.run('INSERT OR IGNORE INTO exercise_likes(record_id,user_id) VALUES(?,?)', record.id, user.id);
  else db.run('DELETE FROM exercise_likes WHERE record_id=? AND user_id=?', record.id, user.id);
  return accessible(user, record.id);
}
function ranking(user, now = new Date()) {
  harvest.participant(user);
  const { weekStart, weekEnd } = dates(now);
  const ranked = `WITH counts AS (SELECT r.user_id,COUNT(DISTINCT r.work_date) AS days FROM exercise_records r JOIN users u ON u.id=r.user_id
    WHERE r.deleted_at IS NULL AND ${publicCondition} AND r.work_date BETWEEN ?1 AND ?2 GROUP BY r.user_id), ranked AS (
    SELECT u.id,u.display_name AS name,c.days,ROW_NUMBER() OVER(ORDER BY c.days DESC,u.id) AS rank FROM counts c JOIN users u ON u.id=c.user_id)`;
  return { weekStart, weekEnd, items: db.all(`${ranked} SELECT * FROM ranked ORDER BY rank LIMIT 3`, weekStart, weekEnd), me: db.get(`${ranked} SELECT * FROM ranked WHERE id=?3`, weekStart, weekEnd, user.id) || null };
}
function processDueReminders(now = new Date()) {
  const { today } = dates(now), time = timeFormat.format(now), midnight = Date.parse(`${today}T00:00:00+08:00`);
  return db.tx(() => {
    const rows = db.all(`SELECT s.user_id AS id FROM exercise_settings s JOIN users u ON u.id=s.user_id
      WHERE s.reminder_enabled=1 AND s.reminder_time<=? AND s.reminded_date IS NOT ? AND u.status='active' AND u.role IN ('admin','employee')
      AND NOT EXISTS(SELECT 1 FROM exercise_records r WHERE r.user_id=s.user_id AND r.work_date=? AND r.deleted_at IS NULL)`, time, today, today);
    for (const user of rows) {
      db.run('UPDATE exercise_settings SET reminded_date=? WHERE user_id=?', today, user.id);
      const { lastInsertRowid: id } = db.run("INSERT INTO system_notices(user_id,kind,created_at) VALUES(?,'exercise',?)", user.id, now.getTime());
      require('./reminderService').queuePushEvent(0, [user.id], { title: '时禾 · 运动提醒', body: '今天动一动了吗？来记录你的运动。', tag: `shihe-exercise-${today}`, path: `/?exercise=1&systemNotice=${id}` }, 'exercise');
      db.run("UPDATE push_events SET expires_at=MIN(expires_at,?) WHERE user_id=? AND push_kind='exercise'", midnight + 86400000, user.id);
    }
    return rows.length;
  });
}
const bodySelect = 'SELECT id,work_date AS date,weight,body_fat AS bodyFat,created_at AS createdAt,updated_at AS updatedAt FROM exercise_body_records';
function bodyRecords(user, query = {}, now = new Date()) {
  harvest.participant(user);
  const { today } = dates(now);
  const from = query.from ?? addDays(today, -89), to = query.to ?? today;
  if (!isDateString(from) || !isDateString(to) || from < '1900-01-01' || to > today || from > to || diffDays(from, to) > 365) {
    throw badRequest('请选择有效的日期范围，单次最多查看 366 天，不能超过今天');
  }
  return { from, to,
    firstDate: db.pluck('SELECT MIN(work_date) FROM exercise_body_records WHERE user_id=?', user.id) || null,
    items: db.all(`${bodySelect} WHERE user_id=? AND work_date BETWEEN ? AND ? ORDER BY work_date`, user.id, from, to),
  };
}
function bodyValue(value, field, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > max || Math.abs(value * 10 - Math.round(value * 10)) > 1e-8) {
    throw badRequest(`${field}请输入 0.1 至 ${max} 之间的数字，最多一位小数`);
  }
  return value;
}
function saveBodyRecord(user, date, body, now = new Date()) {
  harvest.participant(user);
  if (!isDateString(date) || date < '1900-01-01' || date > dates(now).today) throw badRequest('请选择有效的记录日期，不能超过今天');
  if (body.visibility != null && body.visibility !== 'private') throw badRequest('身体记录仅自己可见');
  const weight = bodyValue(body.weight, '体重', 1000), bodyFat = bodyValue(body.bodyFat, '体脂率', 99.9);
  if (weight === null && bodyFat === null) throw badRequest('请至少填写体重或体脂率中的一项');
  return db.tx(() => {
    db.run(`INSERT INTO exercise_body_records(user_id,work_date,weight,body_fat,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,work_date) DO UPDATE SET weight=excluded.weight,body_fat=excluded.body_fat,updated_at=excluded.updated_at`, user.id, date, weight, bodyFat, now.toISOString(), now.toISOString());
    return db.get(`${bodySelect} WHERE user_id=? AND work_date=?`, user.id, date);
  });
}
function removeBodyRecord(user, rawId) {
  harvest.participant(user);
  const id = requireInt(rawId, '记录', { min: 1 });
  const result = db.run('DELETE FROM exercise_body_records WHERE id=? AND user_id=?', id, user.id);
  if (!result.changes) throw notFound('身体记录不存在');
  return { deleted: true };
}
module.exports = { bodyRecords, saveBodyRecord, removeBodyRecord, metadata, saveSettings, list, create, remove, images, like, ranking, processDueReminders };
