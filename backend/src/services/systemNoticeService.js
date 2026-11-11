'use strict';

const db = require('../db/db');
const { queuePushEvent } = require('./reminderService');

const TOPIC_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function pushNotice({ id, userId }, kind, { title, body, tag, path }) {
  queuePushEvent(0, [userId], { title, body, tag, path: `${path}&systemNotice=${id}` }, kind);
}

function enrollmentOpened(period, { sendPush = true } = {}) {
  db.run("DELETE FROM system_notices WHERE kind='enrollment_open' AND period_id=?", period.id);
  const notices = db.all(`INSERT INTO system_notices (user_id, kind, period_id, created_at)
    SELECT u.id, 'enrollment_open', ?, ? FROM users u WHERE u.status='active' AND NOT EXISTS (
      SELECT 1 FROM enrollments e WHERE e.user_id=u.id AND e.period_id=? AND e.status='submitted'
    ) RETURNING id, user_id AS userId`, period.id, Date.now(), period.id);
  if (!sendPush) return;
  for (const notice of notices) {
    pushNotice(notice, 'enrollment_open', { title: '时禾 · 报名开放', body: `「${period.name}」正在报名，点击参与。`,
      tag: `shihe-enrollment-open-${period.id}`, path: `/?enrollment=${period.id}` });
  }
}

function proxyEnrollment(periodId, userId, actor) {
  db.run("DELETE FROM system_notices WHERE kind='proxy_enrollment' AND user_id=? AND period_id=?", userId, periodId);
  const { lastInsertRowid: id } = db.run(`INSERT INTO system_notices (user_id, kind, period_id, actor_id, created_at)
    VALUES (?, 'proxy_enrollment', ?, ?, ?)`, userId, periodId, actor.id, Date.now());
  pushNotice({ id, userId }, 'proxy_enrollment', { title: '时禾 · 代报名', body: `${actor.name}帮你代报名了，点击查看。`,
    tag: `shihe-proxy-enrollment-${periodId}`, path: `/?enrollment=${periodId}` });
}

function newTopic(actorId) {
  const now = Date.now();
  db.run("DELETE FROM system_notices WHERE kind='new_topics' AND created_at<=?", now - TOPIC_COOLDOWN_MS);
  const notices = db.all(`INSERT INTO system_notices (user_id, kind, created_at)
    SELECT u.id, 'new_topics', ? FROM users u WHERE u.status='active' AND u.id<>? AND NOT EXISTS (
      SELECT 1 FROM system_notices n WHERE n.user_id=u.id AND n.kind='new_topics'
    ) RETURNING id, user_id AS userId`, now, actorId);
  for (const notice of notices) {
    pushNotice(notice, 'new_topics', { title: '时禾 · 互动区', body: '互动区有新话题了。',
      tag: 'shihe-new-topics', path: '/?tab=discussions' });
  }
}

function listUnread(userId) {
  return db.all(`SELECT n.id, n.kind, n.period_id AS periodId, p.name AS periodName, u.display_name AS actorName
    FROM system_notices n LEFT JOIN periods p ON p.id=n.period_id LEFT JOIN users u ON u.id=n.actor_id
    WHERE n.user_id=? AND n.read_at IS NULL AND p.deleted_at IS NULL
      AND (n.kind<>'enrollment_open' OR (p.status='enrolling' AND NOT EXISTS (
        SELECT 1 FROM enrollments e WHERE e.user_id=n.user_id AND e.period_id=n.period_id AND e.status='submitted'
      )))
    ORDER BY n.id DESC`, userId);
}

function markRead(userId, id) {
  db.run('UPDATE system_notices SET read_at=? WHERE user_id=? AND id=? AND read_at IS NULL', Date.now(), userId, id);
}

module.exports = { enrollmentOpened, proxyEnrollment, newTopic, listUnread, markRead };
