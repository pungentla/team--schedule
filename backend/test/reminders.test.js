'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webPush = require('web-push');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-reminders-'));
const vapid = webPush.generateVAPIDKeys();
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.WEB_PUSH_SUBJECT = 'https://example.org';
process.env.WEB_PUSH_PUBLIC_KEY = vapid.publicKey;
process.env.WEB_PUSH_PRIVATE_KEY = vapid.privateKey;
const db = require('../src/db/db');
const { migrate, truncateAll } = require('../src/db/migrate');
const users = require('../src/repositories/userRepo');
const periods = require('../src/repositories/periodRepo');
const configs = require('../src/repositories/configRepo');
const schedules = require('../src/repositories/scheduleRepo');
const reminders = require('../src/services/reminderService');
const systemNotices = require('../src/services/systemNoticeService');
const periodService = require('../src/services/periodService');
const enrollmentService = require('../src/services/enrollmentService');
const auth = require('../src/services/authService');
const { hashToken } = require('../src/utils/security');

const day = '2027-01-03';
const subscription = suffix => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: vapid.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') } });
let first, second;
test.beforeEach(() => {
  migrate();
  truncateAll();
  [first, second] = ['FIRST', 'SECOND'].map(employeeNo => users.insertUser({ employeeNo, name: employeeNo, passwordHash: 'fixture', role: 'employee' }));
});
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('只接受浏览器推送地址和有效密钥，重新订阅时同一设备只有一个账号', () => {
  const device = subscription('device');
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://fcm.googleapis.com.evil.test/x', 'https://fcm.googleapis.com:444/x']) {
    assert.throws(() => reminders.saveSubscription(first, { ...device, endpoint }), error => error.status === 400);
  }
  assert.throws(() => reminders.saveSubscription(first, { ...device, keys: { p256dh: 'invalid', auth: device.keys.auth } }), error => error.status === 400);
  reminders.saveSubscription(first, device);
  reminders.removeSubscription(second, device.endpoint);
  assert.equal(reminders.findSubscription(first, device.endpoint).user_id, first);
  reminders.saveSubscription(second, device);
  assert.equal(reminders.findSubscription(first, device.endpoint), undefined);
  assert.equal(reminders.findSubscription(second, device.endpoint).user_id, second);
});

test('退出账号只关闭该用户当前设备的提醒', () => {
  const device = subscription('logout');
  const otherDevice = subscription('other');
  reminders.saveSubscription(first, device);
  reminders.saveSubscription(first, otherDevice);
  const { token } = auth.issueSession(first);
  assert.equal(auth.logout(hashToken(auth.issueSession(second).token), second, { pushEndpoint: device.endpoint }), false);
  assert.ok(reminders.findSubscription(first, device.endpoint));
  assert.equal(auth.logout(hashToken(token), first, { pushEndpoint: device.endpoint }), true);
  assert.equal(reminders.findSubscription(first, device.endpoint), undefined);
  assert.ok(reminders.findSubscription(first, otherDevice.endpoint));
  assert.equal(db.pluck('SELECT COUNT(*) FROM sessions WHERE user_id=?', first), 0);
});

test('业务提醒随事务提交，跳过操作者，发送失败后重试且成功后出队', async t => {
  reminders.saveSubscription(first, subscription('actor'));
  const device = subscription('recipient');
  reminders.saveSubscription(second, device);
  const payload = { title: '时禾 · 新公告', body: '有一条新公告', tag: 'notice', path: '/?notice=1' };
  assert.throws(() => db.tx(() => {
    reminders.queuePushEvent(first, null, payload);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(db.pluck('SELECT COUNT(*) FROM push_events'), 0);

  reminders.queuePushEvent(first, null, payload);
  assert.deepEqual(db.all('SELECT user_id,endpoint FROM push_events').map(row => [row.user_id, row.endpoint]), [[second, device.endpoint]]);
  const send = t.mock.method(webPush, 'sendNotification', async () => {
    if (send.mock.callCount() === 0) throw Object.assign(new Error('temporary'), { code: 'ETIMEDOUT' });
  });
  await reminders.sendQueuedPushEvents();
  assert.equal(db.pluck('SELECT attempts FROM push_events'), 1);
  await reminders.sendQueuedPushEvents();
  assert.equal(send.mock.callCount(), 1);
  db.run('UPDATE push_events SET next_attempt_at=0');
  await reminders.sendQueuedPushEvents();
  assert.equal(send.mock.callCount(), 2);
  assert.deepEqual(JSON.parse(send.mock.calls[1].arguments[1]), payload);
  assert.equal(db.pluck('SELECT COUNT(*) FROM push_events'), 0);
});

test('次日提醒只发送生效安排，同一设备每日一次，失效订阅会移除', async t => {
  const work = configs.insertWorkType({ code: 'WORK', name: '接待' });
  const shift = configs.insertShift({ code: 'AM', name: '早班', startTime: '08:00', endTime: '12:00', seq: 1 });
  for (const [userId, status] of [[first, 'published'], [second, 'draft']]) {
    const periodId = periods.insertPeriod({ name: status, startDate: day, endDate: day, status });
    const runId = schedules.insertRun({ periodId, status, algoVersion: 'fixture', seed: 1, totalNeeded: 1, totalFilled: 1, fillRate: 1, rounds: 0, durationMs: 0, createdBy: first });
    periods.insertSlot(periodId, day, shift);
    schedules.bulkInsertAssignments(runId, periodId, [{ userId, workDate: day, shiftId: shift, workTypeId: work, source: 'algo' }]);
  }
  const good = subscription('good');
  const expired = subscription('expired');
  reminders.saveSubscription(first, good);
  reminders.saveSubscription(first, expired);
  reminders.saveSubscription(second, subscription('draft'));
  const sent = t.mock.method(webPush, 'sendNotification', async ({ endpoint }) => {
    if (endpoint === expired.endpoint) throw Object.assign(new Error('expired'), { statusCode: 410 });
  });
  reminders.setPreference(first, 'next_day_schedule', false);
  await reminders.sendScheduleReminders(day);
  assert.equal(sent.mock.callCount(), 0);
  reminders.setPreference(first, 'next_day_schedule', true);
  await reminders.sendScheduleReminders(day);
  await reminders.sendScheduleReminders(day);
  assert.deepEqual(sent.mock.calls.map(call => call.arguments[0].endpoint), [good.endpoint, expired.endpoint]);
  assert.match(JSON.parse(sent.mock.calls[0].arguments[1]).body, /2027-01-03 有 1 项排班/);
  assert.equal(reminders.findSubscription(first, good.endpoint).reminded_date, day);
  assert.equal(reminders.findSubscription(first, expired.endpoint), undefined);
});

test('开放报名与代报名生成对应周期的提醒，代报名仅通知本人', () => {
  const admin = users.insertUser({ employeeNo: 'ADMIN', name: '值班管理员', passwordHash: 'fixture', role: 'admin' });
  const ctx = { user: users.publicUser(users.findById(admin)) };
  const workTypeId = configs.insertWorkType({ code: 'HELP', name: '接待' });
  const periodId = periods.insertPeriod({ name: '下周排班', startDate: day, endDate: day });
  reminders.saveSubscription(first, subscription('first'));
  reminders.saveSubscription(second, subscription('second'));
  const submit = () => enrollmentService.saveAdminEnrollment(periodId, first, { workTypes: [{ workTypeId }] }, ctx);

  submit();
  const [proxy] = systemNotices.listUnread(first);
  assert.deepEqual({ ...proxy }, { id: proxy.id, kind: 'proxy_enrollment', periodId, periodName: '下周排班', actorName: '值班管理员' });
  assert.deepEqual(systemNotices.listUnread(second), []);
  systemNotices.markRead(second, proxy.id);
  assert.equal(systemNotices.listUnread(first).length, 1);

  periodService.changeStatus(periodId, 'enrolling', ctx);
  periodService.changeStatus(periodId, 'enrolling', ctx);
  assert.deepEqual(systemNotices.listUnread(first).map(n => n.kind), ['proxy_enrollment']);
  const [opened] = systemNotices.listUnread(second);
  assert.equal(opened.kind, 'enrollment_open');
  assert.deepEqual(db.all('SELECT user_id,payload FROM push_events ORDER BY id').map(row => [row.user_id, JSON.parse(row.payload).path]), [
    [first, `/?enrollment=${periodId}&systemNotice=${proxy.id}`],
    [second, `/?enrollment=${periodId}&systemNotice=${opened.id}`],
  ]);
  systemNotices.markRead(first, proxy.id);
  assert.deepEqual(systemNotices.listUnread(first), []);
  periodService.changeStatus(periodId, 'scheduling', ctx);
  assert.deepEqual(systemNotices.listUnread(second), []);
});

test('新话题提醒按用户限频，点为已读也不会在 24 小时内再次推送', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 11) });
  reminders.saveSubscription(first, subscription('publisher'));
  reminders.saveSubscription(second, subscription('reader'));

  systemNotices.newTopic(first);
  assert.deepEqual(systemNotices.listUnread(first), []);
  const [notice] = systemNotices.listUnread(second);
  assert.equal(notice.kind, 'new_topics');
  assert.equal(notice.actorName, null);
  systemNotices.markRead(second, notice.id);
  t.mock.timers.tick(23 * 3600_000);
  systemNotices.newTopic(first);
  assert.deepEqual(systemNotices.listUnread(second), []);
  assert.equal(db.pluck('SELECT COUNT(*) FROM push_events'), 1);

  t.mock.timers.tick(3600_000);
  systemNotices.newTopic(first);
  assert.equal(systemNotices.listUnread(second).length, 1);
  assert.equal(db.pluck('SELECT COUNT(*) FROM push_events'), 2);
});

test('升级为已有报名中周期补站内提醒，避免重复通知已报名的人和设备', () => {
  const periodId = periods.insertPeriod({ name: '开放中的旧周期', startDate: day, endDate: day, status: 'enrolling' });
  db.run("INSERT INTO enrollments (period_id,user_id,status,created_at,updated_at) VALUES (?,?,'submitted','now','now')", periodId, first);
  reminders.saveSubscription(second, subscription('existing'));
  db.exec('DROP TABLE system_notices; PRAGMA user_version=26');
  migrate();
  migrate();
  assert.deepEqual(systemNotices.listUnread(first), []);
  assert.deepEqual(systemNotices.listUnread(second).map(n => [n.kind, n.periodId]), [['enrollment_open', periodId]]);
  assert.equal(db.pluck('SELECT COUNT(*) FROM push_events'), 0);
});

test('系统消息推送默认开启，关闭后仍保留原有和新增的站内未读', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 11) });
  const defaultPreferences = Object.fromEntries(reminders.PUSH_KINDS.map(kind => [kind, true]));
  assert.deepEqual(reminders.getPreferences(second), defaultPreferences);
  reminders.saveSubscription(first, subscription('first'));
  reminders.saveSubscription(second, subscription('second-phone'));
  reminders.saveSubscription(second, subscription('second-tablet'));
  const periodId = periods.insertPeriod({ name: '开放报名', startDate: day, endDate: day, status: 'enrolling' });
  const period = periods.findPeriod(periodId);
  const actor = { id: first, name: '代报名人' };
  db.tx(() => {
    systemNotices.enrollmentOpened(period);
    systemNotices.proxyEnrollment(periodId, second, actor);
    systemNotices.newTopic(first);
    reminders.queuePushEvent(first, [second], { title: '公告', tag: 'notice', path: '/?notice=1' });
  });

  assert.deepEqual(reminders.setPreference(second, 'enrollment_open', false), { ...defaultPreferences, enrollment_open: false });
  assert.deepEqual(systemNotices.listUnread(second).map(n => n.kind), ['new_topics', 'proxy_enrollment', 'enrollment_open']);
  assert.equal(db.pluck("SELECT COUNT(*) FROM push_events WHERE user_id=? AND push_kind='enrollment_open'", second), 0);
  assert.equal(db.pluck("SELECT COUNT(*) FROM push_events WHERE user_id=? AND push_kind='enrollment_open'", first), 1);

  reminders.setPreference(second, 'proxy_enrollment', false);
  reminders.setPreference(second, 'new_topics', false);
  t.mock.timers.tick(24 * 3600_000);
  const nextPeriod = periods.findPeriod(periods.insertPeriod({ name: '下次报名', startDate: day, endDate: day, status: 'enrolling' }));
  db.tx(() => {
    systemNotices.enrollmentOpened(nextPeriod);
    systemNotices.proxyEnrollment(nextPeriod.id, second, actor);
    systemNotices.newTopic(first);
  });
  const unread = systemNotices.listUnread(second);
  assert.deepEqual(unread.map(n => [n.kind, n.periodId]), [
    ['new_topics', null], ['proxy_enrollment', nextPeriod.id], ['enrollment_open', nextPeriod.id],
    ['proxy_enrollment', period.id], ['enrollment_open', period.id],
  ]);
  assert.deepEqual(reminders.getPreferences(first), defaultPreferences);
  assert.deepEqual(db.all('SELECT push_kind FROM push_events WHERE user_id=? ORDER BY id', second).map(row => row.push_kind), [null, null]);

  reminders.setPreference(second, 'enrollment_open', true);
  assert.deepEqual(systemNotices.listUnread(second), unread);
  assert.equal(db.pluck('SELECT COUNT(*) FROM push_events WHERE user_id=? AND push_kind IS NOT NULL', second), 0);
  db.tx(() => systemNotices.enrollmentOpened(nextPeriod));
  assert.equal(db.pluck("SELECT COUNT(*) FROM push_events WHERE user_id=? AND push_kind='enrollment_open'", second), 2);
});

test('从 v27 升级后，关闭开关也会撤销升级前排队的对应推送', () => {
  reminders.saveSubscription(second, subscription('legacy'));
  reminders.queuePushEvent(first, [second], { tag: 'shihe-new-topics', path: '/?tab=discussions&systemNotice=1' });
  reminders.queuePushEvent(first, [second], { tag: 'notice', path: '/?notice=1' });
  db.exec('DROP TABLE push_opt_outs; ALTER TABLE push_events DROP COLUMN push_kind; PRAGMA user_version=27');
  migrate();
  reminders.setPreference(second, 'new_topics', false);
  assert.deepEqual(db.all("SELECT json_extract(payload, '$.tag') AS tag FROM push_events").map(row => row.tag), ['notice']);
});

test('从 v28 升级保留已有推送开关并识别排队的评论回复', () => {
  reminders.saveSubscription(second, subscription('v28'));
  reminders.setPreference(second, 'enrollment_open', false);
  reminders.queuePushEvent(first, [second], { tag: 'shihe-topic-reply-1', body: '有人回复了你的评论。' });
  reminders.queuePushEvent(first, [second], { tag: 'shihe-topic-reply-1', body: '你参与的话题有新回复。' });
  db.exec(`ALTER TABLE push_opt_outs RENAME TO system_notice_opt_outs;
    ALTER TABLE push_events RENAME COLUMN push_kind TO system_notice_kind; PRAGMA user_version=28`);
  migrate();
  assert.equal(reminders.getPreferences(second).enrollment_open, false);
  assert.equal(reminders.getPreferences(second).direct_reply, true);
  reminders.setPreference(second, 'direct_reply', false);
  assert.deepEqual(db.all('SELECT push_kind FROM push_events').map(row => row.push_kind), ['topic_replies']);
});
