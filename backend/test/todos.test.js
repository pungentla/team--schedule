'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.RATE_LIMIT_ENABLED = '0';
const db = require('../src/db/db');
const { migrate, truncateAll, CURRENT_VERSION } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const { issueSession } = require('../src/services/authService');
const { insertUser } = require('../src/repositories/userRepo');
const todos = require('../src/services/todoService');
const reminders = require('../src/services/reminderService');
const webPush = require('web-push');

let server, alice, bob, admin, superAdmin, disabled, tokens;
test.before(async () => {
  db.open(':memory:');
  migrate();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
});
test.beforeEach(t => {
  truncateAll();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-25T00:00:00.000Z') });
  const add = (employeeNo, role = 'employee') => ({ id: insertUser({ employeeNo, name: employeeNo, passwordHash: 'fixture', role }), role });
  alice = add('ALICE'); bob = add('BOB'); admin = add('ADMIN', 'admin'); superAdmin = add('SUPER', 'super_admin'); disabled = add('DISABLED');
  db.run("UPDATE users SET status='disabled' WHERE id=?", disabled.id);
  tokens = new Map([alice, bob, admin, superAdmin].map(user => [user.id, issueSession(user.id).token]));
});
test.after(() => { server.close(); db.close(); });

async function request(user, path = '', { method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/todos${path}`, {
    method, headers: { ...(user && { authorization: `Bearer ${tokens.get(user.id)}` }), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? null : await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result?.data ?? result?.error;
}
const create = (user, body = {}) => request(user, '', { method: 'POST', status: 201, body: { title: '准备聚会', ...body } });
const update = (user, id, body, status = 200) => request(user, `/${id}`, { method: 'PUT', body, status });
const reminder = (user, id, remindAt, status = 200) => request(user, `/${id}/reminder`, { method: 'PUT', body: { remindAt }, status });

test('私密待办在详情、列表、标签、摘要、修改接口均不可被管理员或其他成员读取', async () => {
  await request(null, '', { status: 401 });
  const secret = await create(alice, { visibility: 'private', tags: ['私人行程'], description: '私人描述' });
  assert.equal(secret.visibility, 'private');
  assert.deepEqual((await request(alice, '/tags')), ['私人行程']);
  assert.deepEqual((await request(alice, '?scope=private')).items.map(todo => todo.id), [secret.id]);
  for (const outsider of [bob, admin, superAdmin]) {
    await request(outsider, `/${secret.id}`, { status: 404 });
    assert.equal((await request(outsider, '?scope=public&status=all&keyword=私人')).total, 0);
    assert.equal((await request(outsider, '?scope=mine&status=all')).total, 0);
    assert.equal((await request(outsider, '?scope=private&status=all')).total, 0);
    assert.equal(await request(outsider, '/recent'), undefined);
    assert.deepEqual(await request(outsider, '/tags'), []);
    await update(outsider, secret.id, { title: '越权修改' }, 404);
    await request(outsider, `/${secret.id}`, { method: 'DELETE', status: 404 });
    await reminder(outsider, secret.id, '2026-11-26T00:00:00.000Z', 404);
  }
  const visible = await create(alice, { tags: ['聚会'] });
  assert.equal((await request(bob, `/${visible.id}`)).title, visible.title);
  assert.equal((await request(bob, '?scope=public')).total, 1);
  assert.equal((await request(alice, '?scope=private')).total, 1);
  await update(bob, visible.id, { title: '不是创建者' }, 403);
  await request(bob, `/${visible.id}/completion`, { method: 'PUT', body: { completed: true }, status: 403 });
  await reminder(bob, visible.id, '2026-11-26T00:00:00.000Z', 403);
});

test('管理员分配、独立提醒、执行人完成备注和子任务权限', async () => {
  await request(alice, '', { method: 'POST', body: { title: '越权分配', assigneeId: bob.id }, status: 403 });
  for (const assigneeId of [superAdmin.id, disabled.id, 999]) {
    await request(admin, '', { method: 'POST', body: { title: '不可分配', assigneeId }, status: 400 });
  }
  await request(admin, '', { method: 'POST', body: { title: '不能私密分配', assigneeId: alice.id, visibility: 'private' }, status: 400 });
  const task = await create(admin, { assigneeId: alice.id, priority: 'urgent', tags: ['采购', '采购'],
    remindAt: '2026-11-26T00:00:00.000Z', items: [{ title: '准备茶水' }, { title: '检查音响' }] });
  assert.equal(task.remindAt, null);
  assert.deepEqual(task.tags, ['采购']);
  const employeeTask = await request(alice, `/${task.id}`);
  assert.equal(employeeTask.remindAt, '2026-11-26T00:00:00.000Z');
  assert.deepEqual([employeeTask.canEdit, employeeTask.canComplete], [false, true]);
  await update(alice, task.id, { title: '私自更改' }, 403);
  await request(admin, `/${task.id}/items/${task.items[0].id}`, { method: 'PUT', body: { done: true }, status: 403 });
  await request(alice, `/${task.id}/items/${task.items[0].id}`, { method: 'PUT', body: { done: true } });
  await reminder(admin, task.id, '2026-11-27T00:00:00.000Z');
  await reminder(alice, task.id, '2026-11-28T00:00:00.000Z');
  assert.equal((await request(admin, `/${task.id}`)).remindAt, '2026-11-27T00:00:00.000Z');
  assert.equal((await request(alice, `/${task.id}`)).remindAt, '2026-11-28T00:00:00.000Z');
  assert.equal((await request(alice, '/unread'))[0].kind, 'assigned');
  await request(alice, `/${task.id}/read`, { method: 'PUT', status: 204 });
  assert.deepEqual(await request(alice, '/unread'), []);
  assert.equal((await request(alice, `/${task.id}/completion`, { method: 'PUT', body: { completed: true }, status: 409 })).code, 'TODO_ITEMS_PENDING');
  await request(alice, `/${task.id}/items/${task.items[1].id}`, { method: 'PUT', body: { done: true } });
  const done = await request(alice, `/${task.id}/completion`, { method: 'PUT', body: { completed: true, completionNote: '设备已调试完成' } });
  assert.ok(done.completedAt);
  assert.equal(done.completionNote, '设备已调试完成');
  assert.equal(done.items.every(item => item.done), true);
  const again = await request(alice, `/${task.id}/completion`, { method: 'PUT', body: { completed: true, completionNote: '重复点击' } });
  assert.equal(again.completionNote, done.completionNote);
  await request(alice, `/${task.id}/items/${task.items[1].id}`, { method: 'PUT', body: { done: false }, status: 409 });
  assert.equal((await request(alice, '?status=completed')).total, 1);
  await request(alice, `/${task.id}/completion`, { method: 'PUT', body: { completed: false } });
  const reassigned = await update(admin, task.id, { ...task, assigneeId: bob.id });
  assert.equal(reassigned.items[0].id, task.items[0].id);
  assert.equal(reassigned.items[0].done, true);
  assert.equal((await request(alice, `/${task.id}`)).remindAt, null);
  assert.equal((await request(bob, '/unread')).length, 1);
  assert.equal(db.pluck('SELECT COUNT(*) FROM todo_reminders WHERE todo_id=? AND user_id=?', task.id, alice.id), 0);
});

test('工作台优先逾期、再截止时间、无日期最后；搜索、标签、分页和校验', async () => {
  const noDate = await create(alice, { title: '无日期事项', description: '搜索说明', tags: ['活动'] });
  const future = await create(alice, { title: '将来事项', dueAt: '2026-11-26T00:00:00.000Z' });
  const late = await create(alice, { title: '逾期事项', dueAt: '2026-11-24T00:00:00.000Z' });
  await create(bob, { title: '他人公开但不相关', dueAt: '2026-11-23T00:00:00.000Z' });
  assert.equal((await request(alice, '/recent')).id, late.id);
  assert.deepEqual((await request(alice)).items.map(todo => todo.id), [late.id, future.id, noDate.id]);
  assert.equal((await request(alice, '?status=overdue')).total, 1);
  assert.equal((await request(alice, '?keyword=搜索说明&tag=活动')).items[0].id, noDate.id);
  for (const body of [{ title: '' }, { tags: Array(9).fill('标签') }, { tags: ['a'.repeat(21)] }, { dueAt: 'invalid' },
    { repeatKind: 'weekly' }, { remindAt: '2026-11-24T00:00:00.000Z' }, { items: [{ title: '' }] }]) {
    await request(alice, '', { method: 'POST', status: 400, body: { title: '校验', ...body } });
  }
  for (let i = 0; i < 31; i++) todos.create({ title: `事项${i}` }, alice);
  const second = await request(alice, '?page=2');
  assert.equal(second.total, 34);
  assert.equal(second.items.length, 4);
});

test('子任务分配给不同人后分别操作，计入各自待办和提醒，全部完成后主执行人确认', async () => {
  await request(alice, '', { method: 'POST', status: 403, body: { title: '不能分配', items: [{ title: '他人工作', assigneeId: bob.id }] } });
  await request(admin, '', { method: 'POST', status: 400, body: { title: '私密不能分配', visibility: 'private', items: [{ title: '不能泄露', assigneeId: alice.id }] } });
  for (const assigneeId of [superAdmin.id, disabled.id, 999]) {
    await request(admin, '', { method: 'POST', status: 400, body: { title: '不可分配', items: [{ title: '子项', assigneeId }] } });
  }
  const task = await create(admin, { title: '多人准备', repeatKind: 'weekly', dueAt: '2026-11-29T02:00:00.000Z', items: [
    { title: '布置场地', assigneeId: alice.id }, { title: '准备茶水', assigneeId: bob.id }, { title: '总体验收' },
  ] });
  assert.deepEqual(task.items.map(item => item.assigneeId), [alice.id, bob.id, admin.id]);
  const aliceTask = await request(alice, `/${task.id}`);
  assert.equal(aliceTask.canComplete, false);
  assert.equal(aliceTask.canRemind, true);
  assert.deepEqual(aliceTask.items.map(item => item.canComplete), [true, false, false]);
  assert.equal((await request(alice)).items[0].id, task.id);
  assert.equal((await request(alice, '/recent')).id, task.id);
  assert.equal((await request(alice, '/unread')).length, 1);
  assert.equal((await request(bob, '/unread')).length, 1);
  await reminder(alice, task.id, '2026-11-26T00:00:00.000Z');
  const setItem = (user, index, status = 200) => request(user, `/${task.id}/items/${task.items[index].id}`, { method: 'PUT', status, body: { done: true } });
  await setItem(admin, 0, 403);
  await setItem(bob, 0, 403);
  await setItem(alice, 0);
  await request(admin, `/${task.id}/completion`, { method: 'PUT', body: { completed: true }, status: 409 });
  await setItem(bob, 1);
  await setItem(admin, 2);
  await request(bob, `/${task.id}/completion`, { method: 'PUT', body: { completed: true }, status: 403 });
  assert.ok((await request(admin, `/${task.id}/completion`, { method: 'PUT', body: { completed: true, completionNote: '各项已确认' } })).completedAt);
  await setItem(alice, 0, 409);
  await update(admin, task.id, { ...task, items: [...task.items, { title: '不能在已完成任务新增' }] }, 409);

  todos.processDueTodos('2026-11-29T02:00:00.000Z');
  const next = db.pluck('SELECT next_todo_id FROM todos WHERE id=?', task.id);
  const nextTodo = todos.get(next, admin);
  assert.deepEqual(nextTodo.items.map(item => [item.assigneeId, item.done]), [[alice.id, false], [bob.id, false], [admin.id, false]]);
  assert.equal(todos.get(next, alice).remindAt, '2026-12-03T00:00:00.000Z');
  await update(admin, next, { ...nextTodo, items: nextTodo.items.map(item => ({ ...item, assigneeId: bob.id, followAssignee: false })) });
  assert.equal(todos.get(next, alice).canRemind, false);
  assert.equal(todos.get(next, alice).remindAt, null);
  assert.equal(todos.unread(alice).some(notice => notice.todoId === next), false);
  await reminder(alice, next, '2026-11-30T00:00:00.000Z', 403);
});

test('v34子任务无损升级，原有子任务默认跟随主执行人', () => {
  const task = todos.create({ title: '旧待办', items: [{ title: '旧子任务' }] }, alice);
  todos.setItem(task.id, task.items[0].id, true, alice);
  db.exec('ALTER TABLE todo_items DROP COLUMN assignee_id; PRAGMA user_version=34');
  migrate();
  const upgraded = todos.get(task.id, alice);
  assert.equal(db.pluck('PRAGMA user_version'), CURRENT_VERSION);
  assert.deepEqual(upgraded.items.map(item => [item.title, item.assigneeId, item.followAssignee, item.done]), [['旧子任务', alice.id, true, true]]);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
});

test('逾期未完成可归档并恢复，停止本条提醒但不影响后续重复，仍可逾期完成', async () => {
  const late = await create(admin, { title: '过期待办', assigneeId: alice.id, dueAt: '2026-11-24T00:00:00.000Z',
    repeatKind: 'weekly', remindAt: '2026-11-26T00:00:00.000Z', items: [{ title: '归档前的子任务' }] });
  const archive = (user, id, archived, status = 200) => request(user, `/${id}/archive`, { method: 'PUT', status, body: { archived } });
  await archive(bob, late.id, true, 403);
  await archive(superAdmin, late.id, true, 403);
  const result = await archive(alice, late.id, true);
  assert.ok(result.archivedAt);
  assert.equal(result.canComplete, false);
  assert.equal(result.items[0].canComplete, false);
  assert.equal((await request(alice)).total, 0);
  assert.equal((await request(alice, '?status=overdue')).total, 0);
  assert.equal(await request(alice, '/recent'), undefined);
  assert.equal((await request(alice, '?status=archived')).items[0].id, late.id);
  assert.equal((await request(alice, '?status=all')).total, 1);
  assert.deepEqual(await request(alice, '/unread'), []);
  await reminder(alice, late.id, '2026-11-27T00:00:00.000Z', 409);
  await request(alice, `/${late.id}/completion`, { method: 'PUT', status: 409, body: { completed: true } });
  await update(admin, late.id, { ...late, title: '归档不能改' }, 409);
  todos.processDueTodos('2026-11-26T00:00:00.000Z');
  const nextId = db.pluck('SELECT next_todo_id FROM todos WHERE id=?', late.id);
  assert.ok(nextId);
  assert.equal(todos.get(nextId, alice).archivedAt, null);
  assert.ok(todos.get(nextId, alice).remindAt);
  assert.equal(todos.unread(alice).some(notice => notice.todoId === late.id), false);
  const restored = await archive(admin, late.id, false);
  assert.equal(restored.archivedAt, null);
  assert.equal((await request(alice, `/${late.id}`)).remindAt, null);
  await request(alice, `/${late.id}/items/${late.items[0].id}`, { method: 'PUT', body: { done: true } });
  const completed = await request(alice, `/${late.id}/completion`, { method: 'PUT', body: { completed: true, completionNote: '逾期后补办完成' } });
  assert.ok(completed.completedAt > completed.dueAt);
  assert.equal((await request(alice, '?status=completed')).total, 1);
  await archive(admin, late.id, true, 400);
  const future = await create(alice, { dueAt: '2026-12-01T00:00:00.000Z' });
  await archive(alice, future.id, true, 400);
  const secret = await create(bob, { visibility: 'private', dueAt: '2026-11-24T00:00:00.000Z' });
  await archive(superAdmin, secret.id, true, 404);
});

test('未配置设备推送时站内提醒仍可生成，幂等、完成取消、提醒修改和删除清理', async () => {
  const task = await create(alice, { visibility: 'private', remindAt: '2026-11-25T01:00:00.000Z' });
  todos.processDueTodos('2026-11-25T01:00:00.000Z');
  todos.processDueTodos('2026-11-25T01:01:00.000Z');
  assert.equal((await request(alice, '/unread')).length, 1);
  assert.deepEqual(await request(bob, '/unread'), []);
  assert.equal(db.pluck('SELECT COUNT(*) FROM push_events'), 0);
  await reminder(alice, task.id, '2026-11-25T02:00:00.000Z');
  assert.deepEqual(await request(alice, '/unread'), []);
  todos.processDueTodos('2026-11-25T02:00:00.000Z');
  assert.equal((await request(alice, '/unread')).length, 1);
  await request(alice, `/${task.id}/completion`, { method: 'PUT', body: { completed: true } });
  assert.deepEqual(await request(alice, '/unread'), []);
  await request(alice, `/${task.id}`, { method: 'DELETE', status: 204 });
  assert.equal(db.pluck('SELECT COUNT(*) FROM todo_reminders'), 0);
  assert.equal(db.pluck('SELECT COUNT(*) FROM todo_notices'), 0);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
});

test('每周到期只生成一次，月末保持原日期，子任务重置、相对提醒延续，停止重复生效', () => {
  const weekly = todos.create({ title: '周日准备', visibility: 'private', dueAt: '2026-11-29T02:00:00.000Z', repeatKind: 'weekly',
    remindAt: '2026-11-29T01:00:00.000Z', items: [{ title: '布置' }] }, alice);
  todos.setItem(weekly.id, weekly.items[0].id, true, alice);
  todos.complete(weekly.id, { completed: true, completionNote: '本次完成' }, alice);
  todos.processDueTodos('2026-11-29T02:00:00.000Z');
  todos.processDueTodos('2026-11-29T02:00:00.000Z');
  const next = db.get('SELECT * FROM todos WHERE repeat_group_id=?', weekly.id);
  assert.equal(db.pluck('SELECT COUNT(*) FROM todos WHERE repeat_group_id=?', weekly.id), 1);
  assert.equal(next.due_at, '2026-12-06T02:00:00.000Z');
  assert.equal(next.visibility, 'private');
  assert.equal(next.completed_at, null);
  assert.equal(todos.get(next.id, alice).items[0].done, false);
  assert.equal(todos.get(next.id, alice).remindAt, '2026-12-06T01:00:00.000Z');
  todos.update(next.id, { ...todos.get(next.id, alice), repeatKind: 'none' }, alice);
  todos.processDueTodos('2026-12-06T02:00:00.000Z');
  assert.equal(db.pluck('SELECT COUNT(*) FROM todos'), 2);

  const monthly = todos.create({ title: '月末检查', dueAt: '2027-01-31T15:59:00.000Z', repeatKind: 'monthly' }, alice);
  todos.processDueTodos('2027-01-31T15:59:00.000Z');
  let month = db.get('SELECT * FROM todos WHERE repeat_group_id=? ORDER BY id DESC LIMIT 1', monthly.id);
  assert.equal(month.due_at, '2027-02-28T15:59:00.000Z');
  todos.processDueTodos('2027-02-28T15:59:00.000Z');
  month = db.get('SELECT * FROM todos WHERE repeat_group_id=? ORDER BY id DESC LIMIT 1', monthly.id);
  assert.equal(month.due_at, '2027-03-31T15:59:00.000Z');
  todos.remove(monthly.id, alice);
  todos.processDueTodos('2027-04-30T15:59:00.000Z');
  assert.equal(db.pluck("SELECT COUNT(*) FROM todos WHERE repeat_kind<>'none'"), 0);
});

test('待办提醒定向推送到本人，关闭推送保留站内消息，完成时撤回待发送推送', async t => {
  const keys = webPush.generateVAPIDKeys();
  for (const user of [alice, bob]) reminders.saveSubscription(user.id, {
    endpoint: `https://fcm.googleapis.com/fcm/send/todo-${user.id}`,
    keys: { p256dh: keys.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') },
  });
  const privateTodo = todos.create({ title: '私密提醒', visibility: 'private', remindAt: '2026-11-25T01:00:00.000Z' }, alice);
  const assigned = todos.create({ title: '分配提醒', assigneeId: bob.id, remindAt: '2026-11-25T01:00:00.000Z' }, admin);
  db.run('DELETE FROM push_events');
  reminders.setPreference(bob.id, 'todo', false);
  todos.processDueTodos('2026-11-25T01:00:00.000Z');
  assert.deepEqual(db.all('SELECT user_id FROM push_events').map(row => row.user_id), [alice.id]);
  assert.equal(todos.unread(bob).length, 2);
  const send = t.mock.method(webPush, 'sendNotification', async () => {});
  await reminders.sendQueuedPushEvents();
  assert.equal(send.mock.callCount(), 1);
  const [subscription, payload] = send.mock.calls[0].arguments;
  assert.ok(subscription.endpoint.endsWith(`todo-${alice.id}`));
  assert.equal(JSON.parse(payload).path, `/?todo=${privateTodo.id}`);
  assert.equal(JSON.parse(payload).body.includes('私密提醒'), false);
  reminders.setPreference(bob.id, 'todo', true);
  todos.setReminder(assigned.id, '2026-11-25T02:00:00.000Z', bob);
  todos.processDueTodos('2026-11-25T02:00:00.000Z');
  assert.equal(db.pluck('SELECT COUNT(*) FROM push_events'), 1);
  todos.complete(assigned.id, { completed: true }, bob);
  assert.equal(db.pluck('SELECT COUNT(*) FROM push_events'), 0);
  const own = todos.create({ title: '无设备服务也提醒', remindAt: '2026-11-25T03:00:00.000Z' }, alice);
  t.mock.timers.setTime(Date.parse('2026-11-25T03:00:00.000Z'));
  const stop = reminders.startScheduleReminders();
  stop();
  assert.ok(todos.unread(alice).some(notice => notice.todoId === own.id));
});

test('升级v33保留推送开关和原有用户，待办推送默认开启且支持单独关闭', () => {
  db.exec(`DROP TABLE todo_notices; DROP TABLE todo_reminders; DROP TABLE todo_items; DROP TABLE todos;
    DROP TABLE push_opt_outs; CREATE TABLE push_opt_outs (user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK(kind IN ('announcement')), PRIMARY KEY(user_id,kind)); PRAGMA user_version=33;`);
  db.run("INSERT INTO push_opt_outs VALUES (?,'announcement')", alice.id);
  migrate();
  assert.equal(db.pluck('PRAGMA user_version'), CURRENT_VERSION);
  assert.equal(db.pluck('SELECT COUNT(*) FROM users'), 5);
  assert.equal(reminders.getPreferences(alice.id).announcement, false);
  assert.equal(reminders.getPreferences(alice.id).todo, true);
  reminders.setPreference(alice.id, 'todo', false);
  assert.equal(reminders.getPreferences(alice.id).todo, false);
  assert.equal(migrate().fromVersion, CURRENT_VERSION);
});
