'use strict';

const express = require('express');
const db = require('../db/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { queuePushEvent } = require('../services/reminderService');
const { nowIso } = require('../utils/date');
const { requireString } = require('../utils/validate');

const router = express.Router();

router.get('/current', requireAuth, (_req, res) => {
  const announcement = db.get(`SELECT a.title, a.content, a.published_at AS publishedAt, u.name AS publisherName
    FROM announcements a LEFT JOIN users u ON u.id = a.published_by WHERE a.id = 1`);
  res.set('Cache-Control', 'no-store').json({ data: announcement || null });
});

router.put('/current', requireAuth, requireAdmin, (req, res) => {
  const title = requireString(req.body?.title, '公告标题', { max: 60 });
  const content = requireString(req.body?.content, '公告正文', { max: 2000 });
  const publishedAt = nowIso();
  db.tx(() => {
    db.run(`INSERT INTO announcements (id, title, content, published_by, published_at) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content,
        published_by=excluded.published_by, published_at=excluded.published_at`, title, content, req.user.id, publishedAt);
    queuePushEvent(req.user.id, null, {
      title: '时禾 · 新公告', body: '有一条新公告，打开时禾查看。', tag: 'shihe-announcement', path: '/?notice=1',
    });
  });
  res.json({ data: { title, content, publishedAt, publisherName: req.user.name } });
});

module.exports = router;
