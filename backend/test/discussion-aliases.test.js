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
const { setPreference } = require('../src/services/reminderService');

test('旧匿名话题补上昵称，新话题和定向回复按话题复用昵称并隐藏实名', async t => {
  db.open(':memory:');
  migrate();
  const [author, member] = ['发帖者实名', '回复者实名'].map((name, index) =>
    insertUser({ employeeNo: `U${index}`, name, passwordHash: 'fixture', role: 'employee' }));
  db.exec('DROP TABLE discussion_aliases; PRAGMA user_version = 20');
  const oldTopic = db.run(`INSERT INTO discussion_topics (author_id, category, title, content, created_at, is_anonymous)
    VALUES (?, 'chat', '旧匿名话题', '正文', 'now', 1)`, author).lastInsertRowid;
  const oldReply = db.run('INSERT INTO discussion_replies (topic_id, author_id, content, created_at) VALUES (?, ?, ?, ?)',
    oldTopic, member, '旧评论', 'now').lastInsertRowid;
  migrate();

  const tokens = new Map([author, member].map(userId => [userId, issueSession(userId).token]));
  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => { server.close(); db.close(); });
  await once(server, 'listening');
  async function request(userId, route, body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/discussions${route}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${tokens.get(userId)}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, body ? 201 : 200, JSON.stringify(result));
    return result.data;
  }

  const oldDetail = await request(member, `/${oldTopic}`);
  assert.equal(oldDetail.authorName, null);
  assert.ok(oldDetail.anonymousName);
  db.run("INSERT INTO push_subscriptions (endpoint,user_id,p256dh,auth) VALUES ('fixture',?,'fixture','fixture')", member);
  setPreference(member, 'direct_reply', false);
  await request(author, `/${oldTopic}/replies`, { content: '新回复', replyToId: oldReply });
  const unread = await request(member, '/unread-replies');
  assert.equal(unread.find(n => n.id === oldTopic).kind, 'direct_reply');
  assert.equal(db.pluck('SELECT COUNT(*) FROM push_events WHERE user_id=?', member), 0);
  const { items: [first, second] } = await request(member, `/${oldTopic}/replies`);
  assert.ok(first.anonymousName);
  assert.notEqual(first.anonymousName, oldDetail.anonymousName);
  assert.equal(second.anonymousName, oldDetail.anonymousName);
  assert.equal(second.replyToAnonymousName, first.anonymousName);
  assert.equal(second.authorName, null);
  assert.equal(second.replyToName, null);
  await request(author, `/${oldTopic}/replies`, { content: '一条普通评论' });
  assert.equal(db.pluck('SELECT push_kind FROM push_events WHERE user_id=?', member), 'topic_replies');

  const created = await request(author, '/', { category: 'chat', title: '新匿名话题', content: '正文', anonymous: true });
  await request(member, `/${created.id}/replies`, { content: '新话题的评论' });
  await request(member, `/${created.id}/replies`, { content: '同一个人的第二条评论' });
  const { items: [a, b] } = await request(author, `/${created.id}/replies`);
  const list = await request(member, '/');
  const detail = await request(author, `/${created.id}`);
  assert.equal(list.items.find(topic => topic.id === created.id).anonymousName, detail.anonymousName);
  assert.ok(a.anonymousName);
  assert.equal(a.anonymousName, b.anonymousName);
  assert.notEqual(a.anonymousName, detail.anonymousName);
  assert.equal(a.authorName, null);
  assert.equal(db.pluck('SELECT COUNT(*) FROM discussion_aliases WHERE topic_id = ?', created.id), 2);

  const publicTopic = await request(author, '/', { category: 'chat', title: '实名话题', content: '正文' });
  const publicDetail = await request(member, `/${publicTopic.id}`);
  assert.equal(publicDetail.authorName, '发帖者实名');
  assert.equal(publicDetail.anonymousName, null);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
});
