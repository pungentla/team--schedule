'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto'), { once } = require('node:events');
process.env.RATE_LIMIT_ENABLED = '0';
const db = require('../src/db/db'), { migrate, truncateAll } = require('../src/db/migrate');
const { insertUser } = require('../src/repositories/userRepo'), { issueSession } = require('../src/services/authService');
const { createApp } = require('../src/app'), harvest = require('../src/services/harvestService'), wishes = require('../src/services/wishService');
let users;
test.before(() => { db.open(':memory:'); migrate(); });
test.beforeEach(() => {
  truncateAll();
  users = ['employee', 'admin', 'employee', 'super_admin', 'employee'].map((role, i) => ({ id: insertUser({ employeeNo: `RANK${i}`, name: `成员${i}`, passwordHash: 'fixture', role }), role }));
  db.run("UPDATE users SET status='disabled' WHERE id=?", users[4].id);
});
test.after(() => db.close());
function earn(index, amount) { db.run('INSERT INTO playground_harvest(user_id,source_key,game,amount,reason,created_at) VALUES(?,?,?,?,?,?)', users[index].id, randomUUID(), 'quiz', amount, '测试收获', new Date().toISOString()); }
test('分别聚合收获与消费，禾穗按余额、许愿按次数排序，删除话题仍计入次数', () => {
  earn(0, 80); earn(0, 40); earn(1, 90); earn(2, 20); earn(3, 999); earn(4, 999);
  const a = wishes.create(users[0], { requestKey: randomUUID(), presetId: 'hello' });
  wishes.create(users[0], { requestKey: randomUUID(), presetId: 'prayer' });
  wishes.create(users[1], { requestKey: randomUUID(), presetId: 'joy' });
  db.run('DELETE FROM discussion_topics WHERE id=?', a.topicId);
  const balance = harvest.leaderboard(users[2]);
  assert.equal(balance.total, 3);
  assert.deepEqual(balance.items.map(p => [p.id, p.balance, p.wishCount, p.rank]), [[users[0].id, 60, 2, 1], [users[1].id, 60, 1, 2], [users[2].id, 20, 0, 3]]);
  assert.equal(balance.me.rank, 3);
  earn(1, 10);
  assert.equal(harvest.leaderboard(users[0]).items[0].id, users[1].id);
  assert.equal(harvest.leaderboard(users[1], { sort: 'wishes' }).items[0].id, users[0].id);
  assert.equal(harvest.balance(users[0].id), 60);
});
test('排行榜仅返回当前展示名称和统计，零值人员保留，花名禁用后即时回到姓名', () => {
  db.run('UPDATE users SET nickname=?,nickname_enabled=1 WHERE id=?', '青禾', users[0].id);
  const row = harvest.leaderboard(users[0]).items[0];
  assert.equal(row.name, '青禾');
  assert.deepEqual(Object.keys(row).sort(), ['balance', 'id', 'name', 'rank', 'wishCount']);
  assert.equal(row.balance, 0); assert.equal(row.wishCount, 0);
  db.run('UPDATE users SET nickname_enabled=0 WHERE id=?', users[0].id);
  assert.equal(harvest.leaderboard(users[0]).me.name, '成员0');
});
test('分页排行连续且不重复，我的排名不受页码影响；拒绝无效排序和页码', () => {
  for (let i = 0; i < 21; i++) insertUser({ employeeNo: `EXTRA${i}`, name: `同伴${i}`, passwordHash: 'fixture', role: 'employee' });
  const first = harvest.leaderboard(users[1]), second = harvest.leaderboard(users[1], { page: 2 });
  assert.equal(first.total, 24); assert.equal(first.items.length, 20); assert.equal(second.items.length, 4);
  assert.deepEqual([...first.items, ...second.items].map(p => p.rank), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(new Set([...first.items, ...second.items].map(p => p.id)).size, 24);
  assert.deepEqual(first.me, second.me);
  for (const query of [{ sort: 'invalid' }, { sort: 'balance;DROP TABLE users' }, { page: 0 }, { page: 1.5 }, { page: 100001 }]) assert.throws(() => harvest.leaderboard(users[0], query), e => e.status === 400);
});
test('HTTP排行榜必须登录，超级管理员不可参与，返回禁止缓存且不可指定他人身份', async () => {
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/playground/leaderboard`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const headers = { Authorization: `Bearer ${issueSession(users[1].id).token}` };
    const response = await fetch(`${url}?sort=wishes&userId=${users[0].id}`, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).data.me.id, users[1].id);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${issueSession(users[3].id).token}` } })).status, 403);
    assert.equal((await fetch(`${url}?sort=other`, { headers })).status, 400);
  } finally { server.close(); }
});
