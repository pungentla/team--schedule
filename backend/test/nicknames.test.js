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

test('花名全局显示、实名映射仅供账号管理，禁用和启用不消耗命名次数', async t => {
  db.open(':memory:');
  migrate();
  const employee = insertUser({ employeeNo: 'E1', name: '员工原名', passwordHash: 'fixture' });
  const admin = insertUser({ employeeNo: 'A1', name: '管理员原名', passwordHash: 'fixture', role: 'admin' });
  db.exec(`ALTER TABLE users DROP COLUMN display_name;
    ALTER TABLE users DROP COLUMN nickname_enabled;
    ALTER TABLE users DROP COLUMN nickname;
    ALTER TABLE users DROP COLUMN nickname_changed_at;
    PRAGMA user_version = 21`);
  assert.deepEqual(migrate(), { fromVersion: 21, toVersion: 23 });
  const tokens = new Map([employee, admin].map(id => [id, issueSession(id).token]));
  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => { server.close(); db.close(); });
  await once(server, 'listening');
  async function request(id, route, { method = 'GET', body, status = 200 } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method, headers: { authorization: `Bearer ${tokens.get(id)}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result.data ?? result.error;
  }
  const save = (nickname, status, enabled) => request(employee, '/auth/me/nickname', { method: 'PUT', body: { nickname, enabled }, status });
  const saveAsAdmin = (nickname, status) => request(admin, '/auth/me/nickname', { method: 'PUT', body: { nickname, enabled: true }, status });
  const toggle = enabled => request(employee, '/auth/me/nickname/status', { method: 'PUT', body: { enabled } });
  const post = (id, route, body) => request(id, route, { method: 'POST', body, status: 201 });
  const plain = await post(employee, '/discussions', { category: 'chat', title: '普通话题', content: '正文' });
  const anonymous = await post(employee, '/discussions', { category: 'chat', title: '匿名话题', content: '正文', anonymous: true });
  const before = await request(admin, `/discussions/${anonymous.id}`);
  const employeeReply = await post(employee, `/discussions/${plain.id}/replies`, { content: '第一条' });
  await post(admin, `/discussions/${plain.id}/replies`, { content: '第二条', replyToId: employeeReply.id });

  assert.equal((await request(employee, '/auth/me')).name, '员工原名');
  const savedDisabled = await save('  青禾  ', 200, false);
  assert.equal(savedDisabled.name, '员工原名');
  assert.equal(savedDisabled.nickname, '青禾');
  assert.equal((await saveAsAdmin(' 青禾 ', 409)).code, 'NICKNAME_TAKEN');
  assert.equal((await request(admin, '/auth/me')).nickname, null);
  const profile = await save('青禾', 200, true);
  assert.equal((await saveAsAdmin('青禾', 409)).code, 'NICKNAME_TAKEN');
  assert.equal(profile.name, '青禾');
  assert.equal(profile.nickname, '青禾');
  assert.equal(profile.nicknameEnabled, true);
  assert.equal(profile.nicknameNextChangeAt, savedDisabled.nicknameNextChangeAt);
  assert.equal(Date.parse(profile.nicknameNextChangeAt) - Date.parse(db.pluck('SELECT nickname_changed_at FROM users WHERE id=?', employee)), 30 * 86400000);
  assert.equal((await save('青禾')).nicknameNextChangeAt, profile.nicknameNextChangeAt);
  assert.equal((await save('远山', 409)).details.nextChangeAt, profile.nicknameNextChangeAt);

  const { items } = await request(admin, `/discussions/${plain.id}/replies`);
  assert.equal((await request(admin, `/discussions/${plain.id}`)).authorName, '青禾');
  assert.equal(items[0].authorName, '青禾');
  assert.equal(items[1].replyToName, '青禾');
  const after = await request(admin, `/discussions/${anonymous.id}`);
  assert.equal(after.authorName, null);
  assert.equal(after.anonymousName, before.anonymousName);
  assert.equal((await request(employee, '/admin/users', { status: 403 })).code, 'FORBIDDEN');
  const [account] = await request(admin, '/admin/users?keyword=青禾');
  assert.equal(account.name, '员工原名');
  assert.equal(account.nickname, '青禾');

  assert.equal((await save('', 400)).code, 'BAD_REQUEST');
  const disabled = await toggle(false);
  assert.equal(disabled.name, '员工原名');
  assert.equal(disabled.nickname, '青禾');
  assert.equal(disabled.nicknameEnabled, false);
  assert.equal(disabled.nicknameNextChangeAt, profile.nicknameNextChangeAt);
  assert.equal((await request(admin, `/discussions/${plain.id}`)).authorName, '员工原名');
  assert.equal((await request(admin, '/admin/users?keyword=青禾'))[0].nicknameEnabled, false);
  assert.equal((await save('远山', 409, true)).code, 'NICKNAME_COOLDOWN');
  assert.equal((await request(employee, '/auth/me')).nicknameEnabled, false);
  assert.equal((await toggle(true)).name, '青禾');
  assert.equal((await toggle(true)).nicknameNextChangeAt, profile.nicknameNextChangeAt);
  db.run('UPDATE users SET nickname_changed_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', employee);
  assert.equal((await save('远山')).name, '远山');
  assert.equal((await saveAsAdmin('青禾', 200)).name, '青禾');
});
