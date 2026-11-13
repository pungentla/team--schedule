'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const db = require('../src/db/db');
const { migrate } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const { issueSession } = require('../src/services/authService');
const { insertUser } = require('../src/repositories/userRepo');

test('公告升级保留旧数据，管理员可更换或取消置顶，成员默认看到置顶公告', async t => {
  db.open(':memory:');
  migrate();
  db.exec(`DROP INDEX uq_announcements_pinned;
    ALTER TABLE announcements DROP COLUMN pinned;
    INSERT INTO announcements (title, content, published_at) VALUES ('原有公告', '旧正文', '2026-11-01T00:00:00Z');
    PRAGMA user_version = 32;`);
  migrate();

  const session = (employeeNo, role) => issueSession(insertUser({ employeeNo, name: employeeNo, passwordHash: 'fixture', role })).token;
  const admin = session('ADMIN', 'admin');
  const member = session('MEMBER', 'employee');
  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => { server.close(); db.close(); });
  await once(server, 'listening');

  async function request(path = '', { token = member, method = 'GET', body, status = 200 } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/announcements${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const result = response.status === 204 ? null : await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result?.data;
  }
  const pin = (id, pinned, token = admin, status = 200) => request(`/${id}/pin`, { method: 'PUT', body: { pinned }, token, status });
  const publish = title => request('', { method: 'POST', body: { title, content: '正文' }, token: admin, status: 201 });
  const order = async () => (await request()).map(item => [item.id, item.pinned]);

  const old = await request('/current');
  assert.deepEqual([old.title, old.content, old.pinned], ['原有公告', '旧正文', 0]);
  const second = await publish('第二条');
  await pin(old.id, true, member, 403);
  assert.equal((await request('/current')).id, second.id);

  assert.equal((await pin(old.id, true)).publishedAt, old.publishedAt);
  const third = await publish('第三条');
  assert.deepEqual(await order(), [[old.id, 1], [third.id, 0], [second.id, 0]]);
  await pin(999, true, admin, 404);
  assert.equal((await request('/current')).id, old.id);

  await pin(second.id, true);
  assert.deepEqual(await order(), [[second.id, 1], [third.id, 0], [old.id, 0]]);
  await pin(second.id, false);
  assert.equal((await request('/current')).id, third.id);

  await pin(old.id, true);
  await request(`/${old.id}`, { method: 'DELETE', token: admin, status: 204 });
  assert.deepEqual(await order(), [[third.id, 0], [second.id, 0]]);
});
