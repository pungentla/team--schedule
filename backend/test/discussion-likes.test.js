'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.RATE_LIMIT_ENABLED = '0';
const db = require('../src/db/db');
const { migrate } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const { issueSession } = require('../src/services/authService');
const { insertUser } = require('../src/repositories/userRepo');

test('话题点赞仅提醒作者，已读游标保留新赞，取消点赞清除未读', async t => {
  db.open(':memory:');
  migrate();
  const [author, first, second] = ['AUTHOR', 'FIRST', 'SECOND'].map(employeeNo =>
    insertUser({ employeeNo, name: employeeNo, passwordHash: 'fixture', role: 'employee' }));
  const topic = db.run(`INSERT INTO discussion_topics (author_id, category, title, content, created_at)
    VALUES (?, 'chat', '待点赞的话题', '正文', 'now')`, author).lastInsertRowid;
  db.exec('DROP TABLE discussion_unread_likes; PRAGMA user_version = 19');
  db.run('INSERT INTO discussion_likes (topic_id, user_id) VALUES (?, ?)', topic, author);
  migrate();

  const tokens = new Map([author, first, second].map(userId => [userId, issueSession(userId).token]));
  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => { server.close(); db.close(); });
  await once(server, 'listening');
  async function request(userId, route, body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/discussions${route}`, {
      method: body ? 'PUT' : 'GET', headers: { authorization: `Bearer ${tokens.get(userId)}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    if (response.status === 204) return;
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.data;
  }
  const unread = userId => request(userId, '/unread-likes');
  const like = (userId, liked = true) => request(userId, `/${topic}/like`, { liked });
  const detail = userId => request(userId, `/${topic}`);
  const read = (userId, through) => request(userId, `/${topic}/likes/read`, { through });

  assert.equal((await detail(author)).likeCount, 1);
  assert.deepEqual(await unread(author), []);
  await like(author, false);
  await like(author);
  assert.deepEqual(await unread(author), []);
  await like(first);
  await like(first);
  assert.equal((await unread(author))[0].unreadCount, 1);
  assert.deepEqual(await unread(first), []);
  assert.equal((await detail(first)).unreadLikeThrough, null);
  const { unreadLikeThrough: through } = await detail(author);
  await read(first, through);
  await like(second);
  assert.equal((await unread(author))[0].unreadCount, 2);
  await read(author, through);
  assert.equal((await unread(author))[0].unreadCount, 1);
  await like(second, false);
  assert.deepEqual(await unread(author), []);
  assert.equal((await detail(author)).likeCount, 2);
});
