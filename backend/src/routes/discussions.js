'use strict';

const express = require('express');
const db = require('../db/db');
const { ROLES } = require('../config');
const { requireAuth } = require('../middleware/auth');
const { nowIso } = require('../utils/date');
const { badRequest, forbidden, notFound } = require('../utils/errors');
const { intParam, optionalInt, requireArray, requireBoolean, requireEnum, requireString } = require('../utils/validate');

const router = express.Router();
const PAGE_SIZE = 15;
const MAX_IMAGE_BYTES = 480 * 1024;
const isSuperAdmin = user => user.role === ROLES.SUPER_ADMIN;
const topicSelect = `SELECT t.id, t.category, t.title, t.content, t.article_url AS articleUrl,
    t.created_at AS createdAt, u.name AS authorName,
    (SELECT COUNT(*) FROM discussion_replies r WHERE r.topic_id = t.id) AS replyCount,
    (SELECT COUNT(*) FROM discussion_images i WHERE i.topic_id = t.id) AS imageCount,
    (SELECT COUNT(*) FROM discussion_likes l WHERE l.topic_id = t.id) AS likeCount,
    EXISTS(SELECT 1 FROM discussion_likes l WHERE l.topic_id = t.id AND l.user_id = ?1) AS liked,
    (t.author_id IS ?1 OR ?2) AS canDelete
  FROM discussion_topics t LEFT JOIN users u ON u.id = t.author_id`;
router.use(requireAuth);

function getPage(query) {
  return optionalInt(query.page, '页码', { min: 1, max: 1000000 }) ?? 1;
}

function parseArticleUrl(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const link = requireString(value, '文章链接', { max: 2048 });
  const url = URL.parse(link);
  if (!url || !/^https?:\/\//i.test(link) || url.username || url.password) {
    throw badRequest('请输入有效的 HTTP 或 HTTPS 文章链接');
  }
  return url.href;
}

function parseImage(value) {
  const encoded = requireString(value, '图片', { max: Math.ceil(MAX_IMAGE_BYTES / 3) * 4 });
  const content = Buffer.from(encoded, 'base64');
  if (content.length > MAX_IMAGE_BYTES || content.toString('base64') !== encoded) throw badRequest('图片数据无效或过大');
  if (content.subarray(0, 3).toString('hex') === 'ffd8ff') return { content, mimeType: 'image/jpeg' };
  if (content.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return { content, mimeType: 'image/png' };
  if (content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP') return { content, mimeType: 'image/webp' };
  throw badRequest('图片仅支持 JPG、PNG 或 WebP');
}

router.get('/', (req, res) => {
  const page = getPage(req.query);
  const pageSize = optionalInt(req.query.pageSize, '每页条数', { min: 1, max: PAGE_SIZE }) ?? PAGE_SIZE;
  const sort = requireEnum(req.query.sort ?? 'recent', '话题排序', ['recent', 'hot']);
  const order = sort === 'hot' ? '(likeCount + replyCount) DESC, t.id DESC' : 't.id DESC';
  const items = db.all(`${topicSelect} ORDER BY ${order} LIMIT ? OFFSET ?`, req.user.id, isSuperAdmin(req.user), pageSize, (page - 1) * pageSize);
  const total = db.pluck('SELECT COUNT(*) FROM discussion_topics');
  res.json({ data: { items, total, pageSize } });
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const category = requireEnum(body.category, '话题分类', ['chat', 'feedback', 'share']);
  const title = requireString(body.title, '话题标题', { max: 80 });
  const articleUrl = category === 'share' ? parseArticleUrl(body.articleUrl) : null;
  const images = requireArray(body.images === undefined ? [] : body.images, '图片', { max: 3 }).map(parseImage);
  const content = requireString(body.content ?? '', '话题正文', { min: articleUrl || images.length ? 0 : 1, max: 3000 });
  const id = db.tx(() => {
    const { lastInsertRowid } = db.run(`INSERT INTO discussion_topics (author_id, category, title, content, article_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, req.user.id, category, title, content, articleUrl, nowIso());
    images.forEach((image, index) => db.run('INSERT INTO discussion_images (topic_id, position, mime_type, content) VALUES (?, ?, ?, ?)',
      lastInsertRowid, index + 1, image.mimeType, image.content));
    return lastInsertRowid;
  });
  res.status(201).json({ data: { id } });
});

router.param('id', (req, _res, next, value) => {
  const topicId = intParam(value, '话题');
  if (!db.pluck('SELECT id FROM discussion_topics WHERE id = ?', topicId)) return next(notFound('话题不存在'));
  req.topicId = topicId;
  next();
});

router.get('/:id', (req, res) => {
  res.json({ data: db.get(`${topicSelect} WHERE t.id = ?`, req.user.id, isSuperAdmin(req.user), req.topicId) });
});

router.delete('/:id', (req, res) => {
  const total = db.tx(() => {
    const { changes } = db.run('DELETE FROM discussion_topics WHERE id = ? AND (author_id = ? OR ?)', req.topicId, req.user.id, isSuperAdmin(req.user));
    if (!changes) throw forbidden('只能删除自己发布的话题');
    return db.pluck('SELECT COUNT(*) FROM discussion_topics');
  });
  res.json({ data: { total } });
});

router.put('/:id/like', (req, res) => {
  const liked = requireBoolean(req.body?.liked, '点赞状态');
  const { topicId, user } = req;
  const likeCount = db.tx(() => {
    if (liked) {
      db.run('INSERT INTO discussion_likes (topic_id, user_id) VALUES (?, ?) ON CONFLICT(topic_id, user_id) DO NOTHING', topicId, user.id);
    } else {
      db.run('DELETE FROM discussion_likes WHERE topic_id = ? AND user_id = ?', topicId, user.id);
    }
    return db.pluck('SELECT COUNT(*) FROM discussion_likes WHERE topic_id = ?', topicId);
  });
  res.json({ data: { liked, likeCount } });
});

router.get('/:id/images', (req, res) => {
  const images = db.all('SELECT position, mime_type, content FROM discussion_images WHERE topic_id = ? ORDER BY position', req.topicId);
  res.set('Cache-Control', 'no-store').json({ data: images.map(image => ({
    position: image.position,
    src: `data:${image.mime_type};base64,${Buffer.from(image.content).toString('base64')}`,
  })) });
});

router.get('/:id/replies', (req, res) => {
  const page = getPage(req.query);
  const items = db.all(`SELECT r.id, r.content, r.created_at AS createdAt, u.name AS authorName, (r.author_id IS ? OR ?) AS canDelete
    FROM discussion_replies r LEFT JOIN users u ON u.id = r.author_id WHERE r.topic_id = ?
    ORDER BY r.id ASC LIMIT ? OFFSET ?`, req.user.id, isSuperAdmin(req.user), req.topicId, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const total = db.pluck('SELECT COUNT(*) FROM discussion_replies WHERE topic_id = ?', req.topicId);
  res.json({ data: { items, total, pageSize: PAGE_SIZE } });
});

router.post('/:id/replies', (req, res) => {
  const content = requireString(req.body?.content, '回复内容', { max: 2000 });
  const reply = db.tx(() => {
    const { lastInsertRowid } = db.run('INSERT INTO discussion_replies (topic_id, author_id, content, created_at) VALUES (?, ?, ?, ?)',
      req.topicId, req.user.id, content, nowIso());
    const total = db.pluck('SELECT COUNT(*) FROM discussion_replies WHERE topic_id = ?', req.topicId);
    return { id: lastInsertRowid, page: Math.ceil(total / PAGE_SIZE) };
  });
  res.status(201).json({ data: reply });
});

router.delete('/:id/replies/:replyId', (req, res) => {
  const replyId = intParam(req.params.replyId, '回复');
  const total = db.tx(() => {
    const { changes } = db.run('DELETE FROM discussion_replies WHERE topic_id = ? AND id = ? AND (author_id = ? OR ?)',
      req.topicId, replyId, req.user.id, isSuperAdmin(req.user));
    if (!changes) {
      if (!db.pluck('SELECT id FROM discussion_replies WHERE topic_id = ? AND id = ?', req.topicId, replyId)) throw notFound('回复不存在');
      throw forbidden('只能删除自己发布的回复');
    }
    return db.pluck('SELECT COUNT(*) FROM discussion_replies WHERE topic_id = ?', req.topicId);
  });
  res.json({ data: { total } });
});

module.exports = router;
