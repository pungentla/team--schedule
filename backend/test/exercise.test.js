'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto'), { once } = require('node:events'), webPush = require('web-push');
process.env.RATE_LIMIT_ENABLED = '0';
const db = require('../src/db/db'), { migrate, truncateAll, CURRENT_VERSION } = require('../src/db/migrate');
const { insertUser } = require('../src/repositories/userRepo'), { issueSession } = require('../src/services/authService');
const exercise = require('../src/services/exerciseService'), harvest = require('../src/services/harvestService'), reminders = require('../src/services/reminderService'), notices = require('../src/services/systemNoticeService');
const { createApp } = require('../src/app');
const now = new Date('2026-11-26T10:00:00Z');
let users, tokens, server, base;
function input(overrides = {}) { return { requestKey: randomUUID(), category: 'strength', sportName: '臀腿训练', date: '2026-11-26', minutes: 30, visibility: 'public', ...overrides }; }
function record(index = 0, body = {}, clock = now) { return exercise.create(users[index], input(body), clock); }
async function request(path, { method = 'GET', user = 0, body } = {}) {
  const response = await fetch(`${base}/playground/exercise${path}`, { method, headers: { 'content-type': 'application/json', ...(user === null ? {} : { authorization: `Bearer ${tokens[user]}` }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...(await response.json()) };
}
test.before(async () => { db.open(':memory:'); migrate(); server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}/api`; });
test.beforeEach(() => { truncateAll(); users = ['employee', 'admin', 'employee', 'super_admin'].map((role, i) => ({ id: insertUser({ employeeNo: `MOVE${i}`, name: `运动成员${i}`, passwordHash: 'fixture', role }), role })); tokens = users.map(u => issueSession(u.id).token); });
test.after(() => { server?.close(); db.close(); });
test('项目涵盖训练部位、球类与游泳，自定义项目规范化且仅本人可复用', () => {
  const meta = exercise.metadata(users[0], now);
  assert.equal(meta.settings.weeklyGoal, 3); assert.equal(meta.settings.reminderEnabled, false);
  for (const sport of ['臀腿训练', '肩背训练', '足球', '篮球', '羽毛球', '游泳']) assert.ok(meta.catalog.some(c => c.sports.includes(sport)));
  const made = record(0, { sportName: '  壶铃Ａ  ', visibility: 'private' }); assert.equal(made.record.sportName, '壶铃A'); assert.equal(made.record.isCustom, 1);
  assert.deepEqual(exercise.metadata(users[0], now).customSports.map(s => ({ ...s })), [{ category: 'strength', name: '壶铃A' }]); assert.deepEqual(exercise.metadata(users[1], now).customSports, []);
  exercise.remove(users[0], made.record.id); assert.equal(exercise.metadata(users[0], now).customSports.length, 1);
});
test('当天首记奖励2禾穗；重试、多次打卡、删后重建不能重复领奖', () => {
  const body = input(), first = exercise.create(users[0], body, now); assert.equal(first.reward.amount, 2);
  const retry = exercise.create(users[0], body, now); assert.equal(retry.record.id, first.record.id); assert.equal(retry.replayed, true); assert.equal(retry.reward.amount, 0);
  assert.equal(record().reward.amount, 0); exercise.remove(users[0], first.record.id); assert.throws(() => exercise.create(users[0], body, now), e => e.status === 409);
  assert.equal(record().reward.amount, 0); assert.equal(harvest.balance(users[0].id), 2); assert.equal(db.pluck('SELECT COUNT(*) FROM playground_harvest'), 1); assert.equal(harvest.list(users[0]).items[0].gameName, '运动打卡');
});
test('北京午夜换日，最近7天允许补记但无奖励，拒绝未来和无效日期', () => {
  assert.equal(record(0, { date: '2026-11-20' }).reward.amount, 0);
  assert.equal(record(0, { date: '2026-11-27' }, new Date('2026-11-26T16:00:00Z')).reward.amount, 2);
  assert.equal(record(0, {}, new Date('2026-11-26T15:59:59Z')).reward.amount, 2);
  for (const date of ['2026-11-19', '2026-11-27', '2026-02-30', 'bad']) assert.throws(() => record(0, { date }), e => e.status === 400);
  assert.equal(exercise.metadata(users[0], new Date('2026-11-26T16:00:00Z')).today, '2026-11-27');
});
test('按日限制总时长；越界参数与幂等请求内容变化不写入记录或奖励', () => {
  const body = input({ minutes: 1440 }); exercise.create(users[0], body, now);
  assert.throws(() => exercise.create(users[0], { ...body, minutes: 1 }, now), e => e.status === 409); assert.throws(() => record(), /合计/);
  for (const fields of [{ minutes: 0 }, { minutes: 1.5 }, { category: 'bad' }, { sportName: 'a'.repeat(31) }, { sportName: '名字\u200b' }, { visibility: 'all' }, { note: 'a'.repeat(301) }, { images: ['bad'] }, { images: Array(4).fill('bad') }, { requestKey: 'short' }]) assert.throws(() => record(1, fields), e => e.status === 400);
  assert.equal(db.pluck('SELECT COUNT(*) FROM exercise_records'), 1); assert.equal(harvest.balance(users[1].id), 0);
});
test('私密记录照片、日历与榜单不向其他成员或管理员泄漏，不能越权删除', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const a = record(0, { visibility: 'private', images: [png] }).record, b = record(1).record;
  assert.equal(exercise.images(users[0], a.id)[0].src, `data:image/png;base64,${png}`);
  for (const u of [users[1], users[2]]) { assert.throws(() => exercise.images(u, a.id), e => e.status === 404); assert.throws(() => exercise.like(u, a.id, { liked: true }), e => e.status === 404); }
  assert.equal(exercise.list(users[2], { scope: 'public' }, now).total, 1); assert.equal(exercise.list(users[1], { userId: users[0].id }, now).total, 1);
  assert.equal(exercise.list(users[0], { visibility: 'private' }, now).days[0].count, 1); assert.equal(exercise.ranking(users[0], now).me, null);
  assert.throws(() => exercise.remove(users[0], b.id), e => e.status === 403); assert.throws(() => exercise.images(users[3], a.id), e => e.status === 403);
});
test('仅能点赞他人公开记录，点赞可幂等取消，删除后不可访问', () => {
  const id = record().record.id;
  for (let i = 0; i < 2; i++) assert.equal(exercise.like(users[1], id, { liked: true }).likeCount, 1);
  assert.equal(exercise.like(users[1], id, { liked: false }).likeCount, 0); assert.throws(() => exercise.like(users[0], id, { liked: true }), e => e.status === 400);
  exercise.remove(users[0], id); assert.throws(() => exercise.like(users[1], id, { liked: true }), e => e.status === 404);
});
test('周榜按公开打卡天数，非次数和分钟；支持日历、分页、私密筛选', () => {
  record(0, { minutes: 500 }); record(0, { minutes: 500 }); record(1, { date: '2026-11-25', minutes: 1 }); record(1, { minutes: 1 }); record(2, { visibility: 'private' });
  const board = exercise.ranking(users[0], now); assert.equal(board.items[0].id, users[1].id); assert.equal(board.items[0].days, 2); assert.equal(board.me.days, 1); assert.equal(board.me.rank, 2);
  for (let i = 0; i < 22; i++) record(2, { minutes: 1, visibility: 'private' });
  const list = exercise.list(users[2], { month: '2026-11' }, now); assert.equal(list.items.length, 20); assert.equal(list.total, 23); assert.equal(list.days[0].count, 23);
  assert.equal(exercise.list(users[2], { page: 2, date: '2026-11-26' }, now).items.length, 3); assert.equal(exercise.list(users[2], { month: '2026-10' }, now).total, 0);
  for (const query of [{ month: '2026-99' }, { date: '2026-10-01' }]) assert.throws(() => exercise.list(users[0], query, now), e => e.status === 400);
  db.run("UPDATE users SET status='disabled' WHERE id=?", users[1].id); assert.equal(exercise.ranking(users[0], now).items.length, 1);
});
function subscription(i) { const vapid = webPush.generateVAPIDKeys(); reminders.saveSubscription(users[i].id, { endpoint: `https://fcm.googleapis.com/fcm/send/exercise-${i}`, keys: { p256dh: vapid.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') } }); }
test('提醒设置归属本人，默认推送类别开启；关闭推送不关闭站内铃铛', () => {
  assert.equal(reminders.getPreferences(users[0].id).exercise, true);
  for (const i of [0, 1]) { subscription(i); exercise.saveSettings(users[i], { weeklyGoal: 4, reminderEnabled: true, reminderTime: '18:00' }); }
  assert.equal(exercise.metadata(users[0], now).settings.weeklyGoal, 4); assert.equal(exercise.metadata(users[2], now).settings.weeklyGoal, 3); reminders.setPreference(users[0].id, 'exercise', false);
  assert.equal(exercise.processDueReminders(new Date('2026-11-26T09:59:00Z')), 0); assert.equal(exercise.processDueReminders(now), 2); assert.equal(exercise.processDueReminders(now), 0);
  assert.equal(notices.listUnread(users[0].id)[0].kind, 'exercise'); assert.equal(db.pluck('SELECT COUNT(*) FROM push_events WHERE user_id=?', users[0].id), 0); assert.equal(db.pluck('SELECT COUNT(*) FROM push_events WHERE user_id=?', users[1].id), 1);
  const event = db.get('SELECT * FROM push_events'); assert.match(JSON.parse(event.payload).path, /exercise=1&systemNotice=\d+/); assert.ok(event.expires_at <= Date.parse('2026-11-27T00:00:00+08:00'));
  notices.markRead(users[0].id, notices.listUnread(users[0].id)[0].id); assert.equal(notices.listUnread(users[0].id).length, 0);
});
test('当天私密打卡跳过提醒，打卡与关闭提醒清理待发消息，停用成员不提醒', () => {
  for (const i of [0, 1, 2]) { subscription(i); exercise.saveSettings(users[i], { weeklyGoal: 3, reminderEnabled: true, reminderTime: '17:00' }); }
  record(0, { visibility: 'private' }); db.run("UPDATE users SET status='disabled' WHERE id=?", users[2].id); assert.equal(exercise.processDueReminders(now), 1);
  record(1); assert.equal(db.pluck('SELECT COUNT(*) FROM push_events'), 0); assert.equal(notices.listUnread(users[1].id).length, 0);
  assert.equal(exercise.processDueReminders(new Date('2026-11-27T10:00:00Z')), 2);
  exercise.saveSettings(users[1], { weeklyGoal: 3, reminderEnabled: false, reminderTime: '17:00' }); assert.equal(notices.listUnread(users[1].id).length, 0); assert.equal(db.pluck('SELECT COUNT(*) FROM push_events WHERE user_id=?', users[1].id), 0);
  for (const body of [{ weeklyGoal: 0, reminderEnabled: true, reminderTime: '18:00' }, { weeklyGoal: 3, reminderEnabled: true, reminderTime: '99:00' }, { weeklyGoal: 3, reminderEnabled: 'yes', reminderTime: '18:00' }]) assert.throws(() => exercise.saveSettings(users[0], body), e => e.status === 400);
});
test('HTTP接口鉴权、角色限制、请求幂等与图片权限有效', async () => {
  assert.equal((await request('/meta', { user: null })).status, 401); assert.equal((await request('/meta', { user: 3 })).status, 403);
  const date = exercise.metadata(users[0]).today, body = input({ date }); const made = await request('/records', { method: 'POST', body }); assert.equal(made.status, 201);
  assert.equal((await request('/records', { method: 'POST', body })).status, 200); assert.equal((await request('/records?scope=public')).data.total, 1);
  const p = await request('/records', { method: 'POST', body: input({ date, visibility: 'private' }) }); assert.equal((await request(`/records/${p.data.record.id}/images`, { user: 1 })).status, 404);
  assert.equal((await request('/settings', { method: 'PUT', body: { weeklyGoal: 5, reminderEnabled: true, reminderTime: '20:30', userId: users[1].id } })).data.weeklyGoal, 5); assert.equal((await request('/meta', { user: 1 })).data.settings.weeklyGoal, 3);
});
test('v43迁移保留旧消息、偏好与索引，新增运动表幂等且外键完整', () => {
  db.run("INSERT INTO system_notices(user_id,kind,created_at) VALUES(?,'new_topics',?)", users[0].id, Date.now()); db.run("INSERT INTO push_opt_outs(user_id,kind) VALUES(?,'direct_reply')", users[0].id);
  for (const table of ['exercise_likes', 'exercise_images', 'exercise_records', 'exercise_settings']) db.exec(`DROP TABLE ${table}`);
  for (const table of ['system_notices', 'push_opt_outs']) { const ddl = db.readSchemaSql().match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\);`))[0].replace(", 'exercise'", ''); db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old; ${ddl} INSERT INTO ${table} SELECT * FROM ${table}_old; DROP TABLE ${table}_old;`); }
  db.exec('PRAGMA user_version=43'); assert.deepEqual(migrate(), { fromVersion: 43, toVersion: CURRENT_VERSION });
  assert.equal(notices.listUnread(users[0].id)[0].kind, 'new_topics'); assert.equal(reminders.getPreferences(users[0].id).direct_reply, false); assert.equal(reminders.getPreferences(users[0].id).exercise, true);
  assert.equal(db.get("SELECT tbl_name FROM sqlite_master WHERE name='idx_system_notices_user'").tbl_name, 'system_notices'); record(); assert.deepEqual(migrate(), { fromVersion: CURRENT_VERSION, toVersion: CURRENT_VERSION }); assert.deepEqual(db.all('PRAGMA foreign_key_check'), []); assert.equal(db.pluck('PRAGMA quick_check'), 'ok');
});
test('身体记录可单独填写体重或体脂，同一天更新原记录，保留创建时间', () => {
  const first = exercise.saveBodyRecord(users[0], '2026-11-25', { weight: 65.5 }, now);
  assert.equal(first.weight, 65.5); assert.equal(first.bodyFat, null);
  const updated = exercise.saveBodyRecord(users[0], '2026-11-25', { weight: 64.8, bodyFat: 22.3 }, new Date('2026-11-26T11:00:00Z'));
  assert.equal(updated.id, first.id); assert.equal(updated.createdAt, first.createdAt); assert.notEqual(updated.updatedAt, first.updatedAt);
  assert.equal(db.pluck('SELECT COUNT(*) FROM exercise_body_records'), 1);
  const fatOnly = exercise.saveBodyRecord(users[0], '2026-11-26', { bodyFat: 22.1 }, now);
  assert.equal(fatOnly.weight, null); assert.equal(fatOnly.bodyFat, 22.1);
  assert.deepEqual(exercise.bodyRecords(users[0], {}, now).items.map(r => r.date), ['2026-11-25', '2026-11-26']);
});
test('身体记录拒绝无效数值、精度、空值、未来日期和公开设置，不覆盖有效记录', () => {
  const saved = exercise.saveBodyRecord(users[0], '2026-11-26', { weight: 65 }, now);
  for (const body of [{}, { weight: null, bodyFat: '' }, { weight: 0 }, { weight: -1 }, { weight: 1000.1 }, { weight: 60.55 }, { weight: '65' }, { weight: NaN }, { weight: Infinity }, { bodyFat: 100 }, { bodyFat: -1 }, { bodyFat: 23.45 }, { weight: 65, visibility: 'public' }]) {
    assert.throws(() => exercise.saveBodyRecord(users[0], '2026-11-26', body, now), e => e.status === 400);
  }
  for (const date of ['2026-11-27', '2026-02-30', 'bad', '1899-12-31']) assert.throws(() => exercise.saveBodyRecord(users[0], date, { weight: 65 }, now), e => e.status === 400);
  assert.equal(exercise.bodyRecords(users[0], {}, now).items[0].weight, saved.weight);
  assert.equal(db.pluck('SELECT COUNT(*) FROM exercise_body_records'), 1);
});
test('身体记录按登录账号隔离，管理员不能查他人，也不进入运动动态和排行榜', () => {
  const owner = exercise.saveBodyRecord(users[0], '2026-11-26', { weight: 66.6, bodyFat: 23.4 }, now);
  for (const user of [users[1], users[2]]) {
    const result = exercise.bodyRecords(user, { userId: users[0].id, scope: 'public' }, now);
    assert.deepEqual(result.items, []); assert.equal(result.firstDate, null);
    assert.throws(() => exercise.removeBodyRecord(user, owner.id), e => e.status === 404);
  }
  exercise.saveBodyRecord(users[1], '2026-11-26', { weight: 77.7, userId: users[0].id }, now);
  assert.equal(exercise.bodyRecords(users[0], {}, now).items[0].weight, 66.6);
  assert.equal(exercise.bodyRecords(users[1], {}, now).items[0].weight, 77.7);
  assert.equal(exercise.list(users[1], { scope: 'public' }, now).total, 0);
  assert.equal(exercise.ranking(users[0], now).items.length, 0);
  assert.equal(exercise.metadata(users[0], now).todayCount, 0);
  assert.equal(harvest.balance(users[0].id), 0);
  assert.equal(db.pluck('SELECT COUNT(*) FROM system_notices'), 0);
});
test('身体记录支持历史范围查询，按日期升序，范围不超过366天', () => {
  for (const date of ['2026-11-25', '2001-01-02', '2026-11-26']) exercise.saveBodyRecord(users[0], date, { weight: 65 }, now);
  const recent = exercise.bodyRecords(users[0], {}, now);
  assert.equal(recent.items.length, 2); assert.equal(recent.firstDate, '2001-01-02');
  assert.equal(exercise.bodyRecords(users[0], { from: '2001-01-01', to: '2001-12-31' }, now).items[0].date, '2001-01-02');
  assert.equal(exercise.bodyRecords(users[0], { from: '2026-11-25', to: '2026-11-25' }, now).items.length, 1);
  for (const query of [{ from: '2025-01-01' }, { from: '2026-11-27' }, { to: '2026-11-27' }, { from: 'bad' }, { from: '2026-02-30' }, { from: '1899-01-01' }, { from: '2026-11-26', to: '2026-11-25' }]) assert.throws(() => exercise.bodyRecords(users[0], query, now), e => e.status === 400);
});
test('身体记录HTTP接口鉴权并防越权读取、删除和伪造归属', async () => {
  const date = exercise.metadata(users[0]).today;
  for (const [path, method] of [['/body-records', 'GET'], [`/body-records/${date}`, 'PUT'], ['/body-records/1', 'DELETE']]) assert.equal((await request(path, { user: null, method, ...(method === 'PUT' ? { body: { weight: 65 } } : {}) })).status, 401);
  assert.equal((await request('/body-records', { user: 3 })).status, 403);
  const saved = await request(`/body-records/${date}`, { method: 'PUT', body: { weight: 65, bodyFat: 22.5, userId: users[1].id } }); assert.equal(saved.status, 200);
  assert.equal((await request(`/body-records?userId=${users[0].id}`, { user: 1 })).data.items.length, 0);
  assert.equal((await request(`/body-records?userId=${users[1].id}`)).data.items.length, 1);
  assert.equal((await request(`/body-records/${saved.data.id}`, { method: 'DELETE', user: 1 })).status, 404);
  assert.equal((await request(`/body-records/${date}`, { method: 'PUT', body: { weight: 65, visibility: 'public' } })).status, 400);
  assert.equal((await request(`/body-records/${saved.data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request('/body-records')).data.items.length, 0);
  assert.equal((await request(`/body-records/${saved.data.id}`, { method: 'DELETE' })).status, 404);
});
test('身体记录日期以北京时间为准，删除和重录不改变运动奖励', () => {
  exercise.saveBodyRecord(users[0], '2026-11-27', { weight: 65.5 }, new Date('2026-11-26T16:00:00Z'));
  assert.throws(() => exercise.saveBodyRecord(users[0], '2026-11-27', { weight: 65.5 }, new Date('2026-11-26T15:59:59Z')), e => e.status === 400);
  const made = exercise.saveBodyRecord(users[0], '2026-11-26', { weight: 65.6 }, now);
  exercise.removeBodyRecord(users[0], made.id);
  exercise.saveBodyRecord(users[0], '2026-11-26', { bodyFat: 22.2 }, now);
  assert.equal(harvest.balance(users[0].id), 0); assert.equal(exercise.metadata(users[0], now).todayCount, 0);
});
test('v44升级新增身体记录表，保留运动记录、禾穗与推送偏好', () => {
  record(); reminders.setPreference(users[0].id, 'exercise', false);
  const previous = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'exercise_body_records'").map(({ name }) => [name, db.pluck(`SELECT COUNT(*) FROM "${name}"`)]);
  db.exec('DROP TABLE exercise_body_records; PRAGMA user_version=44');
  assert.deepEqual(migrate(), { fromVersion: 44, toVersion: CURRENT_VERSION });
  for (const [name, count] of previous) assert.equal(db.pluck(`SELECT COUNT(*) FROM "${name}"`), count, name);
  assert.equal(exercise.list(users[0], {}, now).total, 1); assert.equal(harvest.balance(users[0].id), 2); assert.equal(reminders.getPreferences(users[0].id).exercise, false);
  exercise.saveBodyRecord(users[0], '2026-11-26', { weight: 65 }, now);
  assert.deepEqual(migrate(), { fromVersion: CURRENT_VERSION, toVersion: CURRENT_VERSION });
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []); assert.equal(db.pluck('PRAGMA quick_check'), 'ok');
});
