'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-recent-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
const db = require('../src/db/db');
const { migrate, truncateAll } = require('../src/db/migrate');
const users = require('../src/repositories/userRepo');
const periods = require('../src/repositories/periodRepo');
const configs = require('../src/repositories/configRepo');
const repo = require('../src/repositories/scheduleRepo');
const schedule = require('../src/services/scheduleService');
const { today, addDays } = require('../src/utils/date');
let me, friend, other, manager, work, otherWork, shift, late;
function run(name, start, end, status = 'published') {
  const period = periods.insertPeriod({ name, startDate: start, endDate: end, status: status === 'published' ? 'published' : 'draft' });
  const id = repo.insertRun({ periodId: period, algoVersion: 'fixture', seed: 1, status, totalNeeded: 10, totalFilled: 0, fillRate: 0, rounds: 0, durationMs: 0, createdBy: manager });
  return { id, period };
}
function assign(r, userId, date, shiftId = shift, workTypeId = work, dutyRole = 'member') {
  periods.insertSlot(r.period, date, shiftId);
  repo.bulkInsertAssignments(r.id, r.period, [{ userId, workDate: date, shiftId, workTypeId, dutyRole, source: 'algo' }]);
  return db.pluck('SELECT MAX(id) FROM assignments');
}
test.beforeEach(() => {
  migrate(); truncateAll();
  [me, friend, other, manager] = ['本人','同伴','其他人','管理员'].map((name, i) => users.insertUser({ employeeNo: `U${i}`, name, passwordHash: 'fixture', role: i === 3 ? 'admin' : 'employee' }));
  work = configs.insertWorkType({ code: 'WORK', name: '接待', requiresRoles: true });
  otherWork = configs.insertWorkType({ code: 'OTHER', name: '其他工作' });
  shift = configs.insertShift({ code: 'AM', name: '早班', startTime: '08:00', endTime: '12:00', seq: 1 });
  late = configs.insertShift({ code: 'PM', name: '晚班', startTime: '16:00', endTime: '20:00', seq: 2 });
});
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('跨周期近7天含首尾，只返回本人安排，并保留工作、时间及主副角色', () => {
  const first = run('第一周期', '2026-11-09', '2026-11-10');
  const second = run('第二周期', '2026-11-15', '2026-11-16');
  assign(first, me, '2026-11-09', shift, work, 'primary'); assign(first, friend, '2026-11-09', shift, work, 'deputy');
  assign(second, me, '2026-11-15'); assign(second, me, '2026-11-16');
  const result = schedule.getRecentSchedule(me, { startDate: '2026-11-09', days: 7 });
  assert.equal(result.endDate, '2026-11-15'); assert.equal(result.assignments.length, 2);
  assert.deepEqual(result.assignments.map((a) => a.periodName), ['第一周期','第二周期']);
  assert.equal(result.assignments[0].dutyRole, 'primary'); assert.equal(result.assignments[0].startTime, '08:00');
  assert.deepEqual(result.assignments[0].coworkers, [{ userId: friend, name: '同伴', dutyRole: 'deputy' }]);
});
test('同伴必须同生效版本、日期、班次及工作，排除自己和其他工作及周期', () => {
  const first = run('本人周期', '2026-11-09', '2026-11-10');
  assign(first, me, '2026-11-09', shift, work, 'primary');
  assign(first, friend, '2026-11-09', shift, work, 'deputy');
  assign(first, other, '2026-11-09', shift, otherWork);
  assign(first, manager, '2026-11-09', late, work);
  assign(first, other, '2026-11-10', shift, work);
  const second = run('同日其他周期', '2026-11-09', '2026-11-09'); assign(second, other, '2026-11-09', shift, work);
  const result = schedule.getRecentSchedule(me, { startDate: '2026-11-09' });
  assert.equal(result.assignments.length, 1); assert.deepEqual(result.assignments[0].coworkers.map((c) => c.userId), [friend]);
});
test('只读生效安排，排除草稿、废弃版本和已释放记录，换班后同伴实时更新', () => {
  const current = run('生效周期', '2026-11-09', '2026-11-10');
  assign(current, me, '2026-11-09'); const old = assign(current, friend, '2026-11-09');
  const released = assign(current, me, '2026-11-10'); repo.releaseAssignment(released); repo.releaseAssignment(old);
  assign(current, manager, '2026-11-09', shift, work, 'deputy');
  assign(run('草稿', '2026-11-09', '2026-11-09', 'draft'), me, '2026-11-09');
  assign(run('作废版本', '2026-11-09', '2026-11-09', 'discarded'), me, '2026-11-09');
  const result = schedule.getRecentSchedule(me, { startDate: '2026-11-09' });
  assert.equal(result.assignments.length, 1); assert.deepEqual(result.assignments[0].coworkers.map((c) => c.userId), [manager]);
  assert.equal(schedule.getRecentSchedule(manager, { startDate: '2026-11-09' }).assignments.length, 1);
});
test('默认从上海时区今天起7天，自定义日期校验边界及空结果', () => {
  const result = schedule.getRecentSchedule(me);
  assert.equal(result.startDate, today()); assert.equal(result.endDate, addDays(today(), 6)); assert.deepEqual(result.assignments, []);
  for (const query of [{ startDate: '2026-02-30' }, { startDate: '2026-11-09', endDate: '2026-11-08' }, { startDate: '2026-01-01', endDate: '2027-01-02' }, { days: 0 }, { days: 367 }]) {
    assert.throws(() => schedule.getRecentSchedule(me, query), (e) => e.status === 400);
  }
  assert.equal(schedule.getRecentSchedule(me, { startDate: '2026-11-09', endDate: '2026-11-09' }).endDate, '2026-11-09');
});
