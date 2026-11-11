'use strict';

const express = require('express');
const db = require('../db/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { queuePushEvent } = require('../services/reminderService');
const { nowIso } = require('../utils/date');
const { notFound } = require('../utils/errors');
const { intParam, requireString } = require('../utils/validate');

const router = express.Router();
const select = `SELECT a.id, a.title, a.content, a.published_at AS publishedAt, u.display_name AS publisherName
  FROM announcements a LEFT JOIN users u ON u.id = a.published_by`;
router.use(requireAuth);

router.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ data: db.all(`${select} ORDER BY a.id DESC`) });
});

router.get('/current', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ data: db.get(`${select} ORDER BY a.id DESC LIMIT 1`) || null });
});

function readFields(req) {
  const title = requireString(req.body?.title, '公告标题', { max: 60 });
  const content = requireString(req.body?.content, '公告正文', { max: 2000 });
  return [title, content];
}

function notifyPublished(userId, id) {
  queuePushEvent(userId, null, {
    title: '时禾 · 新公告', body: '有一条新公告，打开时禾查看。', tag: `shihe-announcement-${id}`, path: `/?notice=${id}`,
  }, 'announcement');
}

function publish(req, replaceCurrent = false) {
  const [title, content] = readFields(req);
  return db.tx(() => {
    const current = replaceCurrent ? db.pluck('SELECT MAX(id) FROM announcements') : null;
    const publishedAt = nowIso();
    const id = current ?? db.run('INSERT INTO announcements (title, content, published_by, published_at) VALUES (?, ?, ?, ?)',
      title, content, req.user.id, publishedAt).lastInsertRowid;
    if (current != null) {
      db.run('UPDATE announcements SET title = ?, content = ?, published_by = ?, published_at = ? WHERE id = ?',
        title, content, req.user.id, publishedAt, id);
    }
    notifyPublished(req.user.id, id);
    return { id, title, content, publishedAt, publisherName: req.user.name };
  });
}

router.post('/', requireAdmin, (req, res) => res.status(201).json({ data: publish(req) }));
router.put('/current', requireAdmin, (req, res) => res.json({ data: publish(req, true) }));

router.put('/:id', requireAdmin, (req, res) => {
  const id = intParam(req.params.id, '公告');
  const { changes } = db.run('UPDATE announcements SET title = ?, content = ? WHERE id = ?', ...readFields(req), id);
  if (!changes) throw notFound('公告不存在');
  res.json({ data: db.get(`${select} WHERE a.id = ?`, id) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const { changes } = db.run('DELETE FROM announcements WHERE id = ?', intParam(req.params.id, '公告'));
  if (!changes) throw notFound('公告不存在');
  res.status(204).end();
});

module.exports = router;
