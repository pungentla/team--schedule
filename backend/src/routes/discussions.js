'use strict';

const express = require('express');
const db = require('../db/db');
const { ROLES } = require('../config');
const { requireAuth } = require('../middleware/auth');
const { ensureAlias } = require('../repositories/discussionAliasRepo');
const { queuePushEvent } = require('../services/reminderService');
const { nowIso } = require('../utils/date');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const { intParam, optionalInt, requireArray, requireBoolean, requireEnum, requireInt, requireString } = require('../utils/validate');

const router = express.Router();
const PAGE_SIZE = 15;
const MAX_IMAGE_BYTES = 480 * 1024;
const CATEGORIES = ['chat', 'feedback', 'share', 'poll'];
const isSuperAdmin = user => user.role === ROLES.SUPER_ADMIN;
const participantSelect = `SELECT author_id FROM discussion_topics WHERE id=?
  UNION SELECT author_id FROM discussion_replies WHERE topic_id=?`;
const topicSelect = `SELECT t.id, t.category, t.title, t.content, t.article_url AS articleUrl,
    t.created_at AS createdAt, t.is_anonymous AS anonymous, t.poll_mode AS pollMode, t.poll_closes_at AS pollClosesAt,
    CASE WHEN t.is_anonymous = 0 THEN u.name END AS authorName,
    a.name AS anonymousName,
    (SELECT COUNT(*) FROM discussion_replies r WHERE r.topic_id = t.id) AS replyCount,
    (SELECT COUNT(*) FROM discussion_images i WHERE i.topic_id = t.id) AS imageCount,
    (SELECT COUNT(*) FROM discussion_likes l WHERE l.topic_id = t.id) AS likeCount,
    EXISTS(SELECT 1 FROM discussion_likes l WHERE l.topic_id = t.id AND l.user_id = ?1) AS liked,
    (t.author_id IS ?1 OR ?2) AS canDelete
  FROM discussion_topics t LEFT JOIN users u ON u.id = t.author_id
  LEFT JOIN discussion_aliases a ON t.is_anonymous = 1 AND a.topic_id = t.id AND a.user_id = t.author_id`;
router.use(requireAuth);

function notifyParticipants(topicId, actorId, body, replyToUserId = null, replyId = null) {
  const participants = db.all(participantSelect, topicId, topicId);
  const notification = {
    title: '时禾 · 话题互动', body, tag: replyId == null ? `shihe-topic-${topicId}` : `shihe-topic-reply-${replyId}`,
    path: replyId == null ? `/?topic=${topicId}` : `/?topic=${topicId}&reply=${replyId}`,
  };
  const otherParticipants = participants.map(row => row.author_id).filter(id => id !== replyToUserId);
  queuePushEvent(actorId, otherParticipants, notification);
  if (replyToUserId !== null) {
    queuePushEvent(actorId, [replyToUserId], { ...notification, body: '有人回复了你的评论。' });
  }
}

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

function loadPollOptions(topicIds, userId) {
  const byTopic = new Map(topicIds.map(id => [id, []]));
  if (!topicIds.length) return byTopic;
  const rows = db.all(`SELECT o.topic_id AS topicId, o.position, o.label,
      CASE WHEN EXISTS (SELECT 1 FROM discussion_poll_votes own WHERE own.topic_id = o.topic_id AND own.user_id = ?)
        THEN COUNT(v.user_id) END AS votes
    FROM discussion_poll_options o LEFT JOIN discussion_poll_votes v
      ON v.topic_id = o.topic_id AND v.position = o.position
    WHERE o.topic_id IN (${topicIds.map(() => '?').join(', ')})
    GROUP BY o.topic_id, o.position ORDER BY o.topic_id, o.position`, userId, ...topicIds);
  for (const { topicId, ...option } of rows) byTopic.get(topicId).push(option);
  return byTopic;
}

function loadVotedPositions(topicId, userId) {
  return db.all('SELECT position FROM discussion_poll_votes WHERE topic_id = ? AND user_id = ? ORDER BY position',
    topicId, userId).map(row => row.position);
}

function pollResults(topicId, userId, { pollMode: mode, anonymous }) {
  const options = loadPollOptions([topicId], userId).get(topicId);
  const votedPositions = loadVotedPositions(topicId, userId);
  const voterCount = votedPositions.length
    ? db.pluck('SELECT COUNT(DISTINCT user_id) FROM discussion_poll_votes WHERE topic_id = ?', topicId) : null;
  if (!anonymous && votedPositions.length) {
    const votersByOption = new Map(options.map(option => [option.position, []]));
    const voters = db.all(`SELECT v.position, u.name FROM discussion_poll_votes v JOIN users u ON u.id = v.user_id
      WHERE v.topic_id = ? ORDER BY v.position, u.name, u.id`, topicId);
    for (const { position, name } of voters) votersByOption.get(position).push(name);
    for (const option of options) option.voters = votersByOption.get(option.position);
  }
  return { mode, options, voterCount, votedPositions, votedFor: mode === 'single' ? votedPositions[0] ?? null : null };
}

router.get('/', (req, res) => {
  const page = getPage(req.query);
  const pageSize = optionalInt(req.query.pageSize, '每页条数', { min: 1, max: PAGE_SIZE }) ?? PAGE_SIZE;
  const sort = requireEnum(req.query.sort ?? 'recent', '话题排序', ['recent', 'hot']);
  const category = req.query.category == null ? null : requireEnum(req.query.category, '话题分类', CATEGORIES);
  const anonymous = req.query.anonymous == null ? null : requireEnum(req.query.anonymous, '匿名筛选', ['true', 'false']) === 'true';
  const before = optionalInt(req.query.before, '话题游标', { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (before != null && (page !== 1 || sort !== 'recent')) throw badRequest('话题游标仅支持按最新顺序加载');
  const order = sort === 'hot' ? '(likeCount + replyCount) DESC, t.id DESC' : 't.id DESC';
  const filters = [];
  const params = [];
  if (category) { filters.push('t.category = ?'); params.push(category); }
  if (anonymous != null) { filters.push('t.is_anonymous = ?'); params.push(anonymous); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const pageWhere = before == null ? where : `${where ? `${where} AND` : 'WHERE'} t.id < ?`;
  const rows = db.all(`${topicSelect} ${pageWhere} ORDER BY ${order} LIMIT ? OFFSET ?`, req.user.id, isSuperAdmin(req.user),
    ...params, ...(before == null ? [] : [before]), pageSize + 1, (page - 1) * pageSize);
  const items = rows.slice(0, pageSize);
  const polls = items.filter(topic => topic.category === 'poll');
  const optionsByTopic = loadPollOptions(polls.map(topic => topic.id), req.user.id);
  for (const topic of polls) topic.pollOptions = optionsByTopic.get(topic.id);
  const nextCursor = sort === 'recent' && rows.length > pageSize ? items.at(-1).id : null;
  const total = db.pluck(`SELECT COUNT(*) FROM discussion_topics t ${where}`, ...params);
  res.set('Cache-Control', 'no-store').json({ data: { items, total, pageSize, nextCursor } });
});

router.get('/unread-replies', (req, res) => {
  const items = db.all(`WITH unread AS (
    SELECT r.topic_id, COUNT(*) AS unreadCount, MAX(r.id) AS latestReplyId
    FROM discussion_unread_replies u JOIN discussion_replies r ON r.id = u.reply_id
    WHERE u.user_id = ?1 GROUP BY r.topic_id
  ) SELECT t.id, t.title, unread.unreadCount, unread.latestReplyId, substr(r.content, 1, 120) AS excerpt,
    CASE WHEN t.author_id = ?1 AND r.parent_reply_id IS NULL THEN 'topic_comment'
      WHEN t.author_id = ?1 THEN 'topic_reply'
      WHEN parent.author_id = ?1 THEN 'direct_reply'
      ELSE 'discussion_reply' END AS kind
    FROM unread JOIN discussion_topics t ON t.id = unread.topic_id
    JOIN discussion_replies r ON r.id = unread.latestReplyId
    LEFT JOIN discussion_replies parent ON parent.id = r.parent_reply_id ORDER BY unread.latestReplyId DESC`, req.user.id);
  res.set('Cache-Control', 'no-store').json({ data: items });
});

router.get('/unread-likes', (req, res) => {
  const items = db.all(`SELECT t.id, t.title, COUNT(l.id) AS unreadCount
    FROM discussion_topics t JOIN discussion_unread_likes l ON l.topic_id = t.id
    WHERE t.author_id = ? GROUP BY t.id ORDER BY MAX(l.id) DESC`, req.user.id);
  res.set('Cache-Control', 'no-store').json({ data: items });
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const category = requireEnum(body.category, '话题分类', CATEGORIES);
  const title = requireString(body.title, '话题标题', { max: 80 });
  const anonymous = body.anonymous === undefined ? false : requireBoolean(body.anonymous, '匿名发布');
  const pollMode = category === 'poll' && body.pollMode !== undefined
    ? requireEnum(body.pollMode, '投票方式', ['single', 'multiple']) : 'single';
  const pollClosesAt = category === 'poll' ? body.pollClosesAt ?? null : null;
  if (pollClosesAt !== null) {
    const deadline = typeof pollClosesAt === 'string' ? Date.parse(pollClosesAt) : NaN;
    if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== pollClosesAt || deadline <= Date.now()) {
      throw badRequest('投票截止时间必须晚于当前时间');
    }
  }
  const pollOptions = category === 'poll' ? requireArray(body.pollOptions, '投票选项', { min: 2, max: 6 })
    .map(value => requireString(value, '投票选项', { max: 80 })) : [];
  if (new Set(pollOptions.map(value => value.toLowerCase())).size !== pollOptions.length) throw badRequest('投票选项不能重复');
  const articleUrl = category === 'share' ? parseArticleUrl(body.articleUrl) : null;
  const images = requireArray(body.images === undefined ? [] : body.images, '图片', { max: 3 }).map(parseImage);
  const content = requireString(body.content ?? '', '话题正文', { min: articleUrl || images.length || pollOptions.length ? 0 : 1, max: 3000 });
  const id = db.tx(() => {
    const { lastInsertRowid } = db.run(`INSERT INTO discussion_topics (author_id, category, title, content, article_url, created_at, is_anonymous, poll_mode, poll_closes_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.user.id, category, title, content, articleUrl, nowIso(), anonymous, pollMode, pollClosesAt);
    if (anonymous) ensureAlias(lastInsertRowid, req.user.id);
    pollOptions.forEach((label, index) => db.run('INSERT INTO discussion_poll_options (topic_id, position, label) VALUES (?, ?, ?)',
      lastInsertRowid, index + 1, label));
    images.forEach((image, index) => db.run('INSERT INTO discussion_images (topic_id, position, mime_type, content) VALUES (?, ?, ?, ?)',
      lastInsertRowid, index + 1, image.mimeType, image.content));
    return lastInsertRowid;
  });
  res.status(201).json({ data: { id, category, anonymous } });
});

router.param('id', (req, _res, next, value) => {
  const topicId = intParam(value, '话题');
  const topic = db.get('SELECT is_anonymous FROM discussion_topics WHERE id = ?', topicId);
  if (!topic) return next(notFound('话题不存在'));
  req.topicId = topicId;
  req.topicAnonymous = topic.is_anonymous;
  next();
});

router.get('/:id', (req, res) => {
  const topic = db.get(`${topicSelect} WHERE t.id = ?`, req.user.id, isSuperAdmin(req.user), req.topicId);
  topic.unreadLikeThrough = db.pluck(`SELECT MAX(l.id) FROM discussion_unread_likes l
    JOIN discussion_topics t ON t.id = l.topic_id WHERE l.topic_id = ? AND t.author_id = ?`, req.topicId, req.user.id);
  if (topic.category === 'poll') topic.poll = pollResults(req.topicId, req.user.id, topic);
  res.set('Cache-Control', 'no-store').json({ data: topic });
});

router.put('/:id/vote', (req, res) => {
  const { topicId, user } = req;
  const poll = db.tx(() => {
    const topic = db.get(`SELECT poll_mode AS pollMode, is_anonymous AS anonymous, poll_closes_at AS pollClosesAt
      FROM discussion_topics WHERE id = ? AND category = 'poll'`, topicId);
    if (!topic) throw badRequest('该话题不支持投票');
    const mode = topic.pollMode;
    const body = req.body || {};
    const input = mode === 'single' && body.positions === undefined ? [body.position]
      : requireArray(body.positions, '投票选项', { min: 1, max: mode === 'single' ? 1 : 6 });
    const positions = input.map(value => requireInt(value, '投票选项', { min: 1, max: 6 }));
    if (new Set(positions).size !== positions.length) throw badRequest('投票选项不能重复');
    const saved = loadVotedPositions(topicId, user.id);
    if (saved.length) {
      if (saved.length === positions.length && saved.every(position => positions.includes(position))) {
        return pollResults(topicId, user.id, topic);
      }
      throw conflict('POLL_ALREADY_VOTED', '投票已提交，不能更改');
    }
    if (topic.pollClosesAt && topic.pollClosesAt <= nowIso()) throw conflict('POLL_CLOSED', '投票已截止');
    const valid = db.pluck(`SELECT COUNT(*) FROM discussion_poll_options
      WHERE topic_id = ? AND position IN (${positions.map(() => '?').join(', ')})`, topicId, ...positions);
    if (valid !== positions.length) throw badRequest('投票选项不存在');
    for (const position of positions) {
      db.run('INSERT INTO discussion_poll_votes (topic_id, user_id, position) VALUES (?, ?, ?)', topicId, user.id, position);
    }
    return pollResults(topicId, user.id, topic);
  });
  res.set('Cache-Control', 'no-store').json({ data: poll });
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
      const { changes } = db.run('INSERT INTO discussion_likes (topic_id, user_id) VALUES (?, ?) ON CONFLICT(topic_id, user_id) DO NOTHING', topicId, user.id);
      if (changes) {
        db.run(`INSERT INTO discussion_unread_likes (topic_id, user_id)
          SELECT id, ? FROM discussion_topics WHERE id = ? AND author_id <> ?`, user.id, topicId, user.id);
        notifyParticipants(topicId, user.id, '你参与的话题收到了点赞。');
      }
    } else {
      db.run('DELETE FROM discussion_likes WHERE topic_id = ? AND user_id = ?', topicId, user.id);
    }
    return db.pluck('SELECT COUNT(*) FROM discussion_likes WHERE topic_id = ?', topicId);
  });
  res.json({ data: { liked, likeCount } });
});

router.put('/:id/likes/read', (req, res) => {
  const through = requireInt(req.body?.through, '已读点赞', { min: 1, max: Number.MAX_SAFE_INTEGER });
  db.run(`DELETE FROM discussion_unread_likes WHERE topic_id = ? AND id <= ? AND EXISTS (
    SELECT 1 FROM discussion_topics WHERE id = discussion_unread_likes.topic_id AND author_id = ?
  )`, req.topicId, through, req.user.id);
  res.status(204).end();
});

router.get('/:id/images', (req, res) => {
  const images = db.all('SELECT position, mime_type, content FROM discussion_images WHERE topic_id = ? ORDER BY position', req.topicId);
  res.set('Cache-Control', 'no-store').json({ data: images.map(image => ({
    position: image.position,
    src: `data:${image.mime_type};base64,${Buffer.from(image.content).toString('base64')}`,
  })) });
});

router.get('/:id/replies', (req, res) => {
  const { topicId, user } = req;
  const replyId = optionalInt(req.query.replyId, '回复', { min: 1, max: Number.MAX_SAFE_INTEGER });
  let page = getPage(req.query);
  if (req.query.page == null) {
    const target = replyId != null && db.pluck('SELECT id FROM discussion_replies WHERE topic_id = ? AND id = ?', topicId, replyId);
    const anchor = target || db.pluck(`SELECT MIN(u.reply_id) FROM discussion_unread_replies u
      JOIN discussion_replies r ON r.id = u.reply_id WHERE u.user_id = ? AND r.topic_id = ?`, user.id, topicId);
    if (anchor) page = 1 + Math.floor(db.pluck('SELECT COUNT(*) FROM discussion_replies WHERE topic_id = ? AND id < ?', topicId, anchor) / PAGE_SIZE);
  }
  const items = db.all(`SELECT r.id, r.content, r.created_at AS createdAt, (unread.reply_id IS NOT NULL) AS unread,
      CASE WHEN t.is_anonymous = 0 THEN u.name END AS authorName, (r.author_id IS ? OR ?) AS canDelete,
      a.name AS anonymousName, parent_alias.name AS replyToAnonymousName,
      parent.id AS replyToId, CASE WHEN t.is_anonymous = 0 THEN parent_user.name END AS replyToName,
      substr(parent.content, 1, 120) AS replyToExcerpt
    FROM discussion_replies r JOIN discussion_topics t ON t.id = r.topic_id LEFT JOIN users u ON u.id = r.author_id
    LEFT JOIN discussion_replies parent ON parent.id = r.parent_reply_id AND parent.topic_id = r.topic_id
    LEFT JOIN users parent_user ON parent_user.id = parent.author_id
    LEFT JOIN discussion_aliases a ON t.is_anonymous = 1 AND a.topic_id = t.id AND a.user_id = r.author_id
    LEFT JOIN discussion_aliases parent_alias ON t.is_anonymous = 1 AND parent_alias.topic_id = t.id AND parent_alias.user_id = parent.author_id
    LEFT JOIN discussion_unread_replies unread ON unread.reply_id = r.id AND unread.user_id = ? WHERE r.topic_id = ?
    ORDER BY r.id ASC LIMIT ? OFFSET ?`, user.id, isSuperAdmin(user), user.id, topicId, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const total = db.pluck('SELECT COUNT(*) FROM discussion_replies WHERE topic_id = ?', topicId);
  const unreadThrough = items.findLast(reply => reply.unread)?.id ?? null;
  res.set('Cache-Control', 'no-store').json({ data: { items, total, pageSize: PAGE_SIZE, page, unreadThrough } });
});

router.put('/:id/replies/read', (req, res) => {
  const { topicId, user } = req;
  let replyIds;
  if (req.body?.replyIds !== undefined) {
    replyIds = requireArray(req.body.replyIds, '已读回复', { min: 1, max: PAGE_SIZE })
      .map(id => requireInt(id, '回复', { min: 1, max: Number.MAX_SAFE_INTEGER }));
  } else {
    const through = intParam(req.body?.through, '已读回复');
    if (!db.pluck('SELECT id FROM discussion_replies WHERE topic_id = ? AND id = ?', topicId, through)) return res.status(204).end();
    const before = db.pluck('SELECT COUNT(*) FROM discussion_replies WHERE topic_id = ? AND id < ?', topicId, through);
    // 旧客户端的游标只清除其所在页。
    replyIds = db.all(`SELECT id FROM discussion_replies WHERE topic_id = ? AND id <= ?
      ORDER BY id LIMIT ? OFFSET ?`, topicId, through, PAGE_SIZE, Math.floor(before / PAGE_SIZE) * PAGE_SIZE).map(row => row.id);
  }
  db.run(`DELETE FROM discussion_unread_replies WHERE user_id = ? AND reply_id IN (
    SELECT id FROM discussion_replies WHERE topic_id = ? AND id IN (${replyIds.map(() => '?').join(', ')})
  )`, user.id, topicId, ...replyIds);
  res.status(204).end();
});

router.post('/:id/replies', (req, res) => {
  const content = requireString(req.body?.content, '回复内容', { max: 2000 });
  const replyToId = optionalInt(req.body?.replyToId, '要回复的评论', { min: 1 });
  const reply = db.tx(() => {
    const parent = replyToId == null ? null
      : db.get('SELECT author_id FROM discussion_replies WHERE id = ? AND topic_id = ?', replyToId, req.topicId);
    if (replyToId != null && !parent) throw notFound('要回复的评论不存在，请重新选择');
    const { lastInsertRowid } = db.run(`INSERT INTO discussion_replies (topic_id, author_id, parent_reply_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)`, req.topicId, req.user.id, replyToId ?? null, content, nowIso());
    if (req.topicAnonymous) ensureAlias(req.topicId, req.user.id);
    db.run(`INSERT INTO discussion_unread_replies (user_id, reply_id)
      SELECT author_id, ? FROM (${participantSelect}) WHERE author_id <> ?`, lastInsertRowid, req.topicId, req.topicId, req.user.id);
    notifyParticipants(req.topicId, req.user.id, '你参与的话题有新回复。', parent?.author_id ?? null, lastInsertRowid);
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
