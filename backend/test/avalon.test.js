'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
process.env.RATE_LIMIT_ENABLED = '0';
const db = require('../src/db/db');
const { migrate, truncateAll, CURRENT_VERSION } = require('../src/db/migrate');
const { insertUser } = require('../src/repositories/userRepo');
const { issueSession } = require('../src/services/authService');
const { createApp } = require('../src/app');
const game = require('../src/services/partyService');
const records = require('../src/services/gameRecordService');
let users, server;
test.before(async () => { db.open(':memory:'); migrate(); server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening'); });
test.beforeEach(() => {
  truncateAll();
  users = Array.from({ length: 12 }, (_, i) => ({ id: insertUser({ employeeNo: `PLAYER${i}`, name: `玩家${i}`, passwordHash: 'fixture', role: i === 11 ? 'super_admin' : i === 10 ? 'admin' : 'employee' }), role: i === 11 ? 'super_admin' : i === 10 ? 'admin' : 'employee' }));
});
test.after(() => { server.close(); db.close(); });
const view = (room, user = users[0]) => game.get(room.id, user);
const act = (room, action, values = {}, user = users[0]) => game.act(room.id, { action, turn: view(room, user).turn, ...values }, user);
function setup(count = 5) {
  const room = game.create(users[0]);
  for (const user of users.slice(1, count)) game.join(room.code, user);
  for (const user of users.slice(0, count)) act(room, 'ready', { ready: true }, user);
  act(room, 'start');
  for (const user of users.slice(0, count)) act(room, 'acknowledge', {}, user);
  return view(room);
}
function roleUsers(room, side) { return room.players.map(p => users.find(u => u.id === p.id)).filter(u => !side || view(room, u).me.role.side === side); }
function propose(room, team) {
  const current = view(room);
  return act(room, 'team', { team }, users.find(u => u.id === current.leaderId));
}
function voteAll(room, approve = true) {
  for (const u of roleUsers(view(room))) act(room, 'vote', { value: approve }, u);
  return view(room);
}
function mission(room, fails = 0) {
  const r = view(room), shadows = roleUsers(r, 'shadow').map(u => u.id), lights = roleUsers(r, 'light').map(u => u.id);
  const team = [...shadows.slice(0, fails), ...lights].slice(0, r.teamSizes[r.round]);
  propose(room, team); voteAll(room); act(room, 'advance');
  team.forEach((uid, i) => act(room, 'mission', { value: i >= fails }, users.find(u => u.id === uid)));
  return view(room);
}

test('房间权限、容量、准备、每个账号一个房间与迁移幂等', () => {
  assert.equal(CURRENT_VERSION, 43); migrate();
  const room = game.create(users[0]);
  assert.match(room.code, /^\d{6}$/);
  assert.throws(() => game.create(users[0]), e => e.code === 'ALREADY_IN_ROOM');
  assert.throws(() => game.get(room.id, users[10]), e => e.status === 404);
  assert.throws(() => game.create(users[11]), e => e.status === 403);
  assert.throws(() => game.join({}, users[1]), e => e.status === 400);
  assert.throws(() => act(room, 'start'), /五至十/);
  for (const user of users.slice(1, 10)) game.join(room.code, user);
  assert.throws(() => game.join(room.code, users[10]), e => e.code === 'ROOM_FULL');
  assert.throws(() => act(room, 'start', {}, users[1]), e => e.status === 403);
  assert.throws(() => act(room, 'start'), /所有成员准备/);
  assert.equal(game.current(users[0]).id, room.id);
  assert.equal(game.join(room.code, users[0]).id, room.id);
});
test('5–10 人角色配比、任务人数、身份知识与返回值保密', () => {
  const goodCounts = [3, 4, 4, 5, 6, 6];
  for (let count = 5; count <= 10; count++) {
    const room = setup(count), all = roleUsers(room), good = roleUsers(room, 'light'), bad = roleUsers(room, 'shadow');
    assert.equal(good.length, goodCounts[count - 5]);
    assert.equal(bad.length, count - good.length);
    assert.deepEqual(room.teamSizes, count === 5 ? [2, 3, 2, 3, 3] : count === 6 ? [2, 3, 4, 3, 4] : count === 7 ? [2, 3, 3, 4, 4] : [3, 4, 4, 5, 5]);
    for (const user of all) {
      const r = view(room, user), role = r.me.role.code;
      assert.ok(!('roles' in r) && !('cards' in r) && !('votes' in r));
      assert.ok(r.players.every(p => !('role' in p)));
      const knowledge = r.me.knowledge;
      if (role === 'prophet') assert.deepEqual(knowledge, bad.map(u => u.id));
      else if (role === 'watcher') assert.deepEqual(knowledge, all.filter(u => ['prophet', 'deceiver'].includes(view(room, u).me.role.code)).map(u => u.id));
      else if (r.me.role.side === 'shadow') assert.deepEqual(knowledge, bad.filter(u => u.id !== user.id).map(u => u.id));
      else assert.deepEqual(knowledge, []);
    }
    assert.throws(() => game.join(room.code, users[10]), e => e.code === 'GAME_STARTED');
    act(room, 'leave');
  }
});
test('队长权限、队伍校验、投票不可覆盖、平票否决和过期操作', () => {
  const room = setup(6), leader = users.find(u => u.id === room.leaderId), other = users.find(u => u.id !== leader.id);
  assert.throws(() => act(room, 'team', { team: [users[0].id, users[1].id] }, other), e => e.status === 403);
  for (const team of [[users[0].id], [users[0].id, users[0].id], [users[0].id, 9999]]) assert.throws(() => propose(room, team), e => e.status === 400);
  const vote = propose(room, users.slice(0, 2).map(u => u.id));
  act(room, 'vote', { value: true }, users[0]);
  assert.equal(view(room, users[1]).me.vote, null);
  assert.equal(view(room, users[1]).history.length, 0);
  assert.throws(() => act(room, 'vote', { value: false }, users[0]), e => e.code === 'ALREADY_SUBMITTED');
  users.slice(1, 6).forEach((u, i) => act(room, 'vote', { value: i < 2 }, u));
  assert.equal(view(room).history.at(-1).approved, false);
  assert.throws(() => game.act(room.id, { action: 'vote', turn: vote.turn, value: true }, users[1]), e => e.code === 'GAME_CHANGED');
  const oldTurn = view(room).turn;
  act(room, 'advance');
  assert.notEqual(view(room).leaderId, leader.id);
  assert.throws(() => game.act(room.id, { action: 'advance', turn: oldTurn }, users[0]), e => e.code === 'GAME_CHANGED');
});
test('连续五次否决结束本局，只有房主可重新开始', () => {
  const room = setup();
  for (let i = 0; i < 5; i++) {
    propose(room, users.slice(0, 2).map(u => u.id)); voteAll(room, false);
    if (i < 4) act(room, 'advance');
  }
  assert.equal(view(room).phase, 'finished'); assert.equal(view(room).winner, 'shadow');
  assert.ok(view(room).players.every(p => p.role));
  const history = records.list(users[0]); assert.equal(history.total, 1);
  const record = records.get(history.items[0].id, users[1]);
  assert.equal(record.history.length, 5); assert.ok(record.players.every(p => p.role)); assert.ok(!record.roles && !record.cards && !record.me);
  assert.throws(() => act(room, 'restart', {}, users[1]), e => e.status === 403);
  const reset = act(room, 'restart');
  assert.equal(reset.phase, 'waiting'); assert.ok(!reset.me.role); assert.equal(reset.history.length, 0);
  assert.equal(records.list(users[0]).total, 1);
});
test('任务牌只允许队员提交，光明不能破坏；只返回聚合结果，三次失败结束', () => {
  const room = setup(), lights = roleUsers(room, 'light'), bad = roleUsers(room, 'shadow');
  const team = [lights[0].id, bad[0].id]; propose(room, team); voteAll(room); act(room, 'advance');
  assert.throws(() => act(room, 'mission', { value: false }, lights[0]), e => e.status === 403);
  assert.throws(() => act(room, 'mission', { value: true }, lights[1]), e => e.status === 403);
  act(room, 'mission', { value: false }, bad[0]);
  assert.equal(view(room, lights[0]).missions.length, 0);
  assert.ok(!JSON.stringify(view(room, lights[0])).includes('"cards"'));
  assert.throws(() => act(room, 'mission', { value: true }, bad[0]), e => e.code === 'ALREADY_SUBMITTED');
  act(room, 'mission', { value: true }, lights[0]);
  assert.deepEqual(view(room).missions[0], { team, fails: 1, success: false }); act(room, 'advance');
  mission(room, 1); act(room, 'advance'); mission(room, 1); act(room, 'advance');
  assert.equal(view(room).winner, 'shadow');
});
test('七人第四次使命一张破坏仍成功，最后指认权限及结果', () => {
  const room = setup(7);
  mission(room, 0); act(room, 'advance'); mission(room, 1); act(room, 'advance'); mission(room, 0); act(room, 'advance');
  assert.equal(view(room).failThreshold, 2);
  mission(room, 1); assert.equal(view(room).missions.at(-1).success, true); act(room, 'advance');
  assert.equal(view(room).phase, 'accusation');
  const assassin = roleUsers(room, 'shadow').find(u => view(room, u).me.role.code === 'tempter');
  const prophet = roleUsers(room, 'light').find(u => view(room, u).me.role.code === 'prophet');
  assert.throws(() => act(room, 'accuse', { targetId: prophet.id }, prophet), e => e.status === 403);
  act(room, 'accuse', { targetId: prophet.id }, assassin);
  assert.equal(view(room).winner, 'shadow');
});
test('三次成功且未指认先知则光明胜利', () => {
  const room = setup();
  for (let i = 0; i < 3; i++) { mission(room, 0); act(room, 'advance'); }
  const assassin = roleUsers(room, 'shadow').find(u => view(room, u).me.role.code === 'tempter');
  const target = roleUsers(room, 'light').find(u => view(room, u).me.role.code !== 'prophet');
  act(room, 'accuse', { targetId: target.id }, assassin); assert.equal(view(room).winner, 'light');
});
test('成员退出结束对局、房主解散释放成员、长期无操作房间失效', () => {
  const room = setup(); act(room, 'leave', {}, users[1]);
  assert.equal(game.current(users[1]), null); assert.equal(view(room).phase, 'finished'); assert.equal(view(room).winner, null);
  act(room, 'leave'); assert.equal(game.current(users[2]), null);
  const fresh = game.create(users[0]); migrate(); assert.equal(game.current(users[0]).id, fresh.id);
  db.run('UPDATE playground_rooms SET updated_at=?', '2000-01-01T00:00:00.000Z');
  assert.equal(game.current(users[0]), null);
});
test('HTTP 鉴权、禁止旁观窃取身份、并发投票只结算一次且响应不缓存', async () => {
  const room = setup(), vote = propose(room, users.slice(0, 2).map(u => u.id));
  const base = `http://127.0.0.1:${server.address().port}/api/playground/rooms`;
  const tokens = users.map(u => issueSession(u.id).token);
  assert.equal((await fetch(`${base}/${room.id}`)).status, 401);
  assert.equal((await fetch(`${base}/${room.id}`, { headers: { authorization: `Bearer ${tokens[10]}` } })).status, 404);
  const results = await Promise.all(users.slice(0, 5).map(async (u, i) => {
    const response = await fetch(`${base}/${room.id}/actions`, { method: 'POST', headers: { authorization: `Bearer ${tokens[i]}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'vote', turn: vote.turn, value: true }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    return (await response.json()).data;
  }));
  assert.ok(results.every(r => r.players.every(p => !p.role) && !r.roles && !r.cards));
  assert.equal(view(room).history.length, 1); assert.equal(view(room).phase, 'voteResult');
});
test('员工选择名单仅包含展示名称和编号，匿名访客不可读', async () => {
  db.run("UPDATE users SET status='disabled' WHERE id=?", users[3].id);
  const base = `http://127.0.0.1:${server.address().port}/api/playground/people`;
  assert.equal((await fetch(base)).status, 401);
  const token = issueSession(users[0].id).token;
  const response = await fetch(base, { headers: { authorization: `Bearer ${token}` } });
  const { data } = await response.json(); assert.equal(response.status, 200);
  assert.ok(data.some(p => p.id === users[0].id));
  assert.ok(data.every(p => Object.keys(p).sort().join(',') === 'id,name' && ![users[3].id, users[11].id].includes(p.id)));
  const recordsPath = `http://127.0.0.1:${server.address().port}/api/playground/records`;
  assert.equal((await fetch(recordsPath)).status, 401);
  assert.equal((await fetch(`${recordsPath}/99999`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
});
test('游戏记录 DELETE 接口鉴权与房主权限，不允许管理员越权', async () => {
  const room = setup(); act(room, 'leave');
  const record = records.list(users[0]).items[0];
  const url = `http://127.0.0.1:${server.address().port}/api/playground/records/${record.id}`;
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 401);
  for (const [user, status] of [[users[1], 403], [users[10], 404]]) {
    const token = issueSession(user.id).token;
    assert.equal((await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, status);
  }
  const token = issueSession(users[0].id).token;
  assert.equal((await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 204);
  assert.equal(records.list(users[1]).total, 0);
});
