'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.RATE_LIMIT_ENABLED = '0';
const db = require('../src/db/db');
const { migrate, CURRENT_VERSION } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const { issueSession } = require('../src/services/authService');
const { insertUser } = require('../src/repositories/userRepo');

test('独立签到保留应到名单和首次签到时间，近期出勤按权限和已结束活动统计', async t => {
  db.open(':memory:');
  migrate();
  const addUser = (employeeNo, role = 'employee') => insertUser({ employeeNo, name: employeeNo, passwordHash: 'fixture', role });
  const admin = addUser('ADMIN', 'admin');
  const alice = addUser('ALICE');
  const bob = addUser('BOB');
  const outsider = addUser('OUTSIDE');
  const superAdmin = addUser('SUPER', 'super_admin');
  db.exec('DROP TABLE attendance_members; DROP TABLE attendance_events; PRAGMA user_version = 30');
  migrate();
  assert.equal(db.pluck('PRAGMA user_version'), CURRENT_VERSION);
  assert.equal(db.pluck('SELECT COUNT(*) FROM users'), 5);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T00:00:00.000Z') });
  const tokens = new Map([admin, alice, bob, outsider, superAdmin].map(id => [id, issueSession(id).token]));
  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => { server.close(); db.close(); });
  await once(server, 'listening');

  async function request(user, path = '', { method = 'GET', body, status = 200 } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/attendance${path}`, {
      method,
      headers: { authorization: `Bearer ${tokens.get(user)}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result.data ?? result.error;
  }
  async function create(title, startsAt, endsAt, memberIds = [alice, bob]) {
    const { id } = await request(admin, '', { method: 'POST', status: 201, body: { title, startsAt, endsAt, memberIds } });
    return id;
  }
  const checkIn = (user, id, status) => request(user, `/${id}/check-in`, { method: 'PUT', status });
  const getPerson = (viewer, member, days) => request(viewer, `/people/${member}?days=${days}`);
  const old = await create('月初活动', '2026-11-01T00:00:00.000Z', '2026-11-01T01:00:00.000Z', [alice]);
  await checkIn(alice, old, 200);
  const attended = await create('周末聚会', '2026-11-10T08:00:00.000Z', '2026-11-10T09:00:00.000Z', [alice, bob, alice]);
  const missed = await create('团队培训', '2026-11-11T08:00:00.000Z', '2026-11-11T09:00:00.000Z');
  const ongoing = await create('正在签到', '2026-11-12T16:15:00.000Z', '2026-11-13T09:00:00.000Z');
  await request(superAdmin, '', { method: 'POST', status: 400, body: {
    title: '超级管理员仅管理', startsAt: '2026-11-10T08:00:00.000Z', endsAt: '2026-11-10T09:00:00.000Z', memberIds: [superAdmin],
  } });
  await checkIn(superAdmin, attended, 403);
  await request(alice, '', { method: 'POST', status: 403 });
  await request(alice, `/${attended}`, { status: 403 });
  await request(alice, `/people/${bob}?days=7`, { status: 403 });
  assert.deepEqual(await request(outsider), []);
  assert.equal((await checkIn(outsider, attended, 404)).code, 'NOT_FOUND');
  assert.equal((await checkIn(alice, attended, 409)).code, 'ATTENDANCE_NOT_OPEN');

  t.mock.timers.setTime(Date.parse('2026-11-10T08:00:00.000Z'));
  const results = await Promise.all([checkIn(alice, attended, 200), checkIn(alice, attended, 200)]);
  assert.deepEqual(results, Array(2).fill({ checkedInAt: '2026-11-10T08:00:00.000Z' }));
  const during = await request(admin, `/${attended}`);
  assert.deepEqual(during.members.map(member => member.status), ['present', 'pending']);

  t.mock.timers.setTime(Date.parse('2026-11-12T16:30:00.000Z'));
  assert.equal((await checkIn(bob, attended, 409)).code, 'ATTENDANCE_CLOSED');
  assert.deepEqual(await checkIn(alice, attended, 200), results[0]);
  await checkIn(alice, ongoing, 200);
  const event = (await request(admin)).find(item => item.id === attended);
  assert.deepEqual([event.attended, event.expected], [1, 2]);
  assert.equal((await request(admin, `/${attended}`)).members.find(member => member.userId === bob).status, 'absent');
  assert.equal(Object.hasOwn((await request(alice))[0], 'expected'), false);
  const week = await getPerson(superAdmin, alice, 7);
  assert.deepEqual([week.startDate, week.endDate, week.attended, week.expected], ['2026-11-07', '2026-11-13', 1, 2]);
  assert.deepEqual(week.events.map(event => [event.id, event.attended, event.expected]), [[missed, 0, 2], [attended, 1, 2]]);
  const teamWeek = await getPerson(admin, 'all', 7);
  assert.deepEqual([teamWeek.attended, teamWeek.expected], [1, 4]);
  assert.deepEqual(teamWeek.events.map(event => event.id), [missed, attended]);
  assert.deepEqual(await getPerson(superAdmin, 'all', 7), teamWeek);
  await request(alice, '/people/all?days=7', { status: 403 });
  const ownStats = await getPerson(alice, alice, 30);
  assert.equal(ownStats.attended, 2);
  assert.deepEqual(ownStats.events.find(event => event.id === attended), week.events[1]);
  assert.equal((await getPerson(admin, outsider, 7)).expected, 0);
  assert.equal(db.pluck('SELECT COUNT(*) FROM periods'), 0);

  const batch = {
    title: '每周日聚会', memberIds: [alice, bob],
    repeat: { startDate: '2026-11-08', endDate: '2026-11-22', weekdays: [0], startTime: '09:00', endTime: '10:30' },
  };
  const publish = (body, status, user = admin) => request(user, '', { method: 'POST', body, status });
  await publish(batch, 403, alice);
  await publish({ ...batch, memberIds: [alice, superAdmin] }, 400);
  await publish({ ...batch, repeat: { ...batch.repeat, endDate: '2026-11-14' } }, 400);
  const { ids, count } = await publish(batch, 201);
  assert.equal(count, 2);
  const series = (await request(alice)).filter(item => item.title === batch.title);
  assert.deepEqual(series.map(item => [item.startsAt, item.endsAt]), [
    ['2026-11-22T01:00:00.000Z', '2026-11-22T02:30:00.000Z'],
    ['2026-11-15T01:00:00.000Z', '2026-11-15T02:30:00.000Z'],
  ]);
  for (const id of ids) {
    assert.deepEqual((await request(admin, `/${id}`)).members.map(member => member.userId), [alice, bob]);
  }
  assert.equal((await publish({ ...batch, repeat: { ...batch.repeat, endDate: '2026-11-29' } }, 409)).code, 'ATTENDANCE_DUPLICATE');
  assert.equal((await request(admin)).filter(item => item.title === batch.title).length, 2);
  assert.deepEqual(await request(outsider), []);

  const proxy = (actor, event, memberIds, status) => request(actor, `/${event}/proxy-check-in`,
    { method: 'PUT', body: { memberIds }, status });
  assert.equal((await proxy(admin, ids[0], [alice, bob], 409)).code, 'ATTENDANCE_NOT_OPEN');
  await proxy(alice, missed, [alice], 403);
  await proxy(admin, missed, [alice, outsider], 400);
  assert.deepEqual((await request(admin, `/${missed}`)).members.map(member => member.status), ['absent', 'absent']);
  assert.deepEqual(await proxy(superAdmin, missed, [alice, bob, alice], 200), { checkedIn: 2, alreadyCheckedIn: 0 });
  assert.deepEqual(await proxy(admin, missed, [alice, bob], 200), { checkedIn: 0, alreadyCheckedIn: 2 });
  const corrected = (await request(admin, `/${missed}`)).members;
  assert.deepEqual(corrected.map(member => [member.status, member.checkedInByName]), [['present', 'SUPER'], ['present', 'SUPER']]);
  assert.equal((await getPerson(alice, alice, 7)).attended, 2);
  assert.deepEqual(await proxy(admin, attended, [alice, bob], 200), { checkedIn: 1, alreadyCheckedIn: 1 });
  const self = (await request(admin, `/${attended}`)).members[0];
  assert.equal(self.checkedInAt, results[0].checkedInAt);
  assert.equal(self.checkedInByName, null);

  const editRoster = (actor, event, changes, status) => request(actor, `/${event}/members`,
    { method: 'PATCH', body: changes, status });
  await editRoster(alice, missed, { add: [outsider] }, 403);
  await editRoster(admin, missed, { add: [superAdmin] }, 400);
  assert.equal((await editRoster(admin, missed, { add: [outsider], remove: [alice] }, 409)).code, 'ATTENDANCE_ALREADY_CHECKED_IN');
  assert.deepEqual(await request(outsider), []);
  await editRoster(admin, ongoing, { remove: [bob] }, 200);
  assert.equal((await checkIn(bob, ongoing, 404)).code, 'NOT_FOUND');
  await editRoster(admin, ids[0], { remove: [alice, bob] }, 400);
  assert.deepEqual(await editRoster(superAdmin, ids[0], { add: [outsider], remove: [bob] }, 200), { added: 1, removed: 1, expected: 2 });
  assert.deepEqual(await editRoster(superAdmin, ids[0], { add: [outsider], remove: [bob] }, 200), { added: 0, removed: 0, expected: 2 });
  assert.deepEqual((await request(outsider)).map(item => item.id), [ids[0]]);
  assert.deepEqual((await request(admin, `/${ids[1]}`)).members.map(member => member.userId), [alice, bob]);
  assert.deepEqual(await editRoster(admin, missed, { add: [outsider] }, 200), { added: 1, removed: 0, expected: 3 });
  const updated = (await request(admin)).find(item => item.id === missed);
  assert.deepEqual([updated.attended, updated.expected], [2, 3]);
  assert.equal((await getPerson(outsider, outsider, 7)).expected, 1);

  await editRoster(admin, missed, { add: [admin] }, 200);
  const teamEvents = async () => (await getPerson(admin, 'all', 7)).events;
  const beforeProxy = await teamEvents();
  assert.deepEqual(beforeProxy.map(event => [event.id, event.isMember, event.checkedInAt]),
    [[missed, 1, null], [attended, 0, null]]);
  await proxy(admin, missed, [admin], 200);
  const afterProxy = await teamEvents();
  assert.equal(afterProxy[0].checkedInAt, '2026-11-12T16:30:00.000Z');

  db.exec('ALTER TABLE attendance_members DROP COLUMN checked_in_by; PRAGMA user_version = 31');
  migrate();
  assert.equal(db.pluck('PRAGMA user_version'), CURRENT_VERSION);
  assert.equal((await request(admin, `/${attended}`)).members[0].checkedInAt, results[0].checkedInAt);
});
