'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-trash-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
const db = require('../src/db/db');
const { migrate, truncateAll, CURRENT_VERSION } = require('../src/db/migrate');
const users = require('../src/repositories/userRepo');
const configs = require('../src/repositories/configRepo');
const periods = require('../src/repositories/periodRepo');
const periodService = require('../src/services/periodService');
const enrollment = require('../src/services/enrollmentService');
const schedule = require('../src/services/scheduleService');
const swaps = require('../src/services/swapService');
const swapRepo = require('../src/repositories/swapRepo');
const stats = require('../src/services/statsService');
let admin, root, employee, second, work, shift, period;
const ctx = (id = admin) => ({ user: users.publicUser(users.findById(id)), requestId: 'trash-test' });
const missing = (fn) => assert.throws(fn, (e) => e.status === 404);
function snapshot() {
  return Object.fromEntries(['period_slots', 'slot_requirements', 'enrollments', 'enrollment_work_types', 'schedule_runs', 'assignments', 'swap_requests', 'swap_participants'].map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY rowid`)]));
}
function publishedFixture() {
  const run = schedule.generate(period, {}, ctx());
  schedule.publish(period, run.runId, ctx());
  const assignment = db.get('SELECT * FROM assignments WHERE run_id=? ORDER BY id LIMIT 1', run.runId);
  const recipient = assignment.user_id === employee ? second : employee;
  const swap = swaps.createSwap({ type: 'transfer', fromAssignmentId: assignment.id, toUserId: recipient }, ctx(assignment.user_id));
  return { run, assignment, recipient, swap };
}
test.beforeEach(() => {
  migrate(); truncateAll();
  [admin, root, employee, second] = ['admin', 'super_admin', 'employee', 'employee'].map((role, i) => users.insertUser({ employeeNo: `U${i}`, name: `人员${i}`, role, passwordHash: 'fixture' }));
  shift = configs.insertShift({ code: 'DAY', name: '日班', startTime: '08:00', endTime: '12:00', seq: 1 });
  work = configs.insertWorkType({ code: 'JOB', name: '工作' });
  period = periodService.createPeriod({ name: '周期', startDate: '2026-11-05', endDate: '2026-11-06', workTypeIds: [work], shiftIds: [shift], initializeRequirements: true }, ctx()).id;
  for (const user of [employee, second]) enrollment.saveAdminEnrollment(period, user, { workTypes: [{ workTypeId: work }] }, ctx());
});
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('管理员和超级管理员可删除，员工不可删除；仅超级管理员可查看和恢复', () => {
  assert.throws(() => periodService.deletePeriod(period, ctx(employee)), (e) => e.status === 403);
  for (const id of [admin, employee]) {
    assert.throws(() => periodService.listDeletedPeriods(ctx(id)), (e) => e.status === 403);
    assert.throws(() => periodService.restorePeriod(period, ctx(id)), (e) => e.status === 403);
  }
  periodService.deletePeriod(period, ctx());
  assert.equal(periods.findPeriod(period), undefined);
  assert.equal(periods.findPeriod(period, { includeDeleted: true }).deleted_by, admin);
  const bin = periodService.listDeletedPeriods(ctx(root));
  assert.equal(bin.length, 1); assert.equal(bin[0].deletedByName, users.findById(admin).name);
  periodService.restorePeriod(period, ctx(root));
  periodService.deletePeriod(period, ctx(root));
  assert.equal(periods.findPeriod(period, { includeDeleted: true }).deleted_by, root);
});
test('已发布周期删除后所有排班、统计、换班待办隐藏，恢复原样并可继续确认', () => {
  const { assignment, recipient, swap } = publishedFixture();
  const original = snapshot();
  assert.equal(swaps.getPendingCount(recipient), 1);
  assert.equal(schedule.getDashboard().pendingParticipantConfirmations, 1);
  assert.throws(() => periodService.deletePeriod(period, ctx()), (e) => e.status === 403);
  assert.equal(periods.findPeriod(period).deleted_at, null);
  periodService.deletePeriod(period, ctx(root));
  assert.deepEqual(snapshot(), original);
  assert.deepEqual(periodService.listPeriods(), []); assert.equal(periods.findCurrentPeriod(), undefined);
  assert.deepEqual(schedule.getMyAssignments(assignment.user_id), []);
  assert.deepEqual(schedule.getRecentSchedule(assignment.user_id, { startDate: '2026-11-05' }).assignments, []);
  assert.equal(stats.getEmployeeHistory(assignment.user_id).total, 0);
  assert.equal(schedule.loadHistory('2026-12-01').size, 0);
  assert.equal(swaps.getPendingCount(recipient), 0); assert.equal(schedule.getDashboard().pendingParticipantConfirmations, 0);
  assert.deepEqual(swapRepo.listSwapsAwaitingMe(recipient), []); assert.deepEqual(swapRepo.listSwapsByRequester(assignment.user_id), []);
  missing(() => swaps.confirm(swap.swap.id, ctx(recipient)));
  const restored = periodService.restorePeriod(period, ctx(root));
  assert.equal(restored.status, 'published'); assert.deepEqual(restored.workTypeIds, [work]); assert.deepEqual(restored.shiftIds, [shift]);
  assert.deepEqual(snapshot(), original);
  assert.ok(schedule.getMyAssignments(assignment.user_id).length);
  assert.ok(schedule.getRecentSchedule(assignment.user_id, { startDate: '2026-11-05' }).assignments.length);
  assert.equal(swaps.getPendingCount(recipient), 1);
  swaps.confirm(swap.swap.id, ctx(recipient));
  assert.equal(swapRepo.findSwap(swap.swap.id).status, 'approved');
});
test('删除后拒绝旧周期的读写、旧草稿调配和已发布直接换班，其他周期正常', () => {
  const { assignment, recipient } = publishedFixture();
  const draft = schedule.generate(period, {}, ctx());
  const other = periodService.createPeriod({ name: '保留', startDate: '2026-11-07', endDate: '2026-11-07' }, ctx()).id;
  periodService.deletePeriod(period, ctx(root));
  for (const fn of [
    () => periodService.getPeriod(period), () => periodService.getRequirementMatrix(period), () => periodService.updatePeriod(period, { name: '不应写入' }, ctx()),
    () => periodService.prepareRequirements(period, ctx()), () => enrollment.getMyEnrollment(period, employee),
    () => enrollment.saveAdminEnrollment(period, employee, { workTypes: [{ workTypeId: work }] }, ctx()),
    () => schedule.getSchedule(period, ctx().user), () => schedule.generate(period, {}, ctx()), () => schedule.publish(period, draft.runId, ctx()),
    () => schedule.getDraftCandidates(draft.runId, { assignmentId: db.get('SELECT id FROM assignments WHERE run_id=?', draft.runId).id }),
    () => stats.getPeriodStats(period), () => swaps.listCandidates(assignment.id, ctx().user),
    () => swaps.reassignByAdmin({ type: 'transfer', fromAssignmentId: assignment.id, toUserId: recipient }, ctx()),
  ]) missing(fn);
  assert.deepEqual(periodService.listPeriods().map((p) => p.id), [other]);
  assert.equal(periods.findCurrentPeriod().id, other);
});
test('重复删除或恢复幂等，审计保留实际操作者；各阶段均按原状态恢复', () => {
  for (const status of ['draft', 'enrolling', 'scheduling', 'published', 'archived']) {
    db.run('UPDATE periods SET status=? WHERE id=?', status, period);
    const operator = status === 'published' ? root : admin;
    periodService.deletePeriod(period, ctx(operator)); periodService.deletePeriod(period, ctx(root));
    assert.equal(periods.findPeriod(period, { includeDeleted: true }).deleted_by, operator);
    assert.equal(periodService.restorePeriod(period, ctx(root)).status, status);
    periodService.restorePeriod(period, ctx(root));
  }
  const logs = db.all("SELECT action,actor_id FROM audit_logs WHERE action IN ('PERIOD_DELETE','PERIOD_RESTORE') ORDER BY id");
  assert.equal(logs.length, 10);
  assert.deepEqual(logs.map((l) => l.actor_id), [admin, root, admin, root, admin, root, root, root, admin, root]);
  missing(() => periodService.deletePeriod(999, ctx())); missing(() => periodService.restorePeriod(999, ctx(root)));
});
test('v6 数据无损迁移到回收站字段，原有周期默认可见且重复迁移幂等', () => {
  const before = snapshot();
  db.exec('ALTER TABLE periods DROP COLUMN deleted_by; ALTER TABLE periods DROP COLUMN deleted_at; PRAGMA user_version=6;');
  assert.deepEqual(migrate(), { fromVersion: 6, toVersion: CURRENT_VERSION });
  assert.deepEqual(snapshot(), before);
  assert.equal(periods.findPeriod(period).deleted_at, null); assert.equal(periods.findPeriod(period).deleted_by, null);
  assert.equal(periodService.listPeriods().length, 1);
  assert.deepEqual(migrate(), { fromVersion: CURRENT_VERSION, toVersion: CURRENT_VERSION });
});
