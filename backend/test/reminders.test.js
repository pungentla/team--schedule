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
  await reminders.sendScheduleReminders(day);
  await reminders.sendScheduleReminders(day);
  assert.deepEqual(sent.mock.calls.map(call => call.arguments[0].endpoint), [good.endpoint, expired.endpoint]);
  assert.match(JSON.parse(sent.mock.calls[0].arguments[1]).body, /2027-01-03 有 1 项排班/);
  assert.equal(reminders.findSubscription(first, good.endpoint).reminded_date, day);
  assert.equal(reminders.findSubscription(first, expired.endpoint), undefined);
});
