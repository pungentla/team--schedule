'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-proxy-enroll-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
const db = require('../src/db/db');
const { migrate, truncateAll } = require('../src/db/migrate');
const users = require('../src/repositories/userRepo');
const configs = require('../src/repositories/configRepo');
const periods = require('../src/repositories/periodRepo');
const periodService = require('../src/services/periodService');
const enrollment = require('../src/services/enrollmentService');
const schedule = require('../src/services/scheduleService');
let admin, root, employee, second, work, shift, period;
const ctx = (id = admin) => ({ user: users.publicUser(users.findById(id)), requestId: 'proxy-test' });
const choices = (role = 'primary') => ({ workTypes: [{ workTypeId: work, priority: 1, dutyRole: role }] });
const proxy = (id, role = 'primary', actor = admin) => enrollment.saveAdminEnrollment(period, id, choices(role), ctx(actor));
test.beforeEach(() => {
  migrate(); truncateAll();
  [admin, root, employee, second] = ['admin', 'super_admin', 'employee', 'employee'].map((role, i) => users.insertUser({ employeeNo: `USER${i}`, name: `人员${i}`, role, passwordHash: 'fixture' }));
  shift = configs.insertShift({ code: 'DAY', name: '日班', startTime: '08:00', endTime: '12:00', seq: 1 });
  work = configs.insertWorkType({ code: 'DUTY', name: '主副值班', requiresRoles: true });
  period = periodService.createPeriod({ name: '代报名', startDate: '2026-11-05', endDate: '2026-11-06', workTypeIds: [work], shiftIds: [shift], initializeRequirements: true }, ctx()).id;
});
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('管理员和超级管理员无需开放本人报名即可代报，直接进入生成并记录实际操作者', () => {
  const first = proxy(employee, 'primary');
  proxy(second, 'deputy', root);
  assert.equal(first.status, 'submitted'); assert.equal(periods.findPeriod(period).status, 'draft');
  assert.equal(enrollment.listEnrollments(period).submittedCount, 2);
  assert.equal(enrollment.getAdminEnrollment(period, employee, ctx()).enrollment.workTypes[0].dutyRole, 'primary');
  const logs = db.all("SELECT actor_id,detail_json FROM audit_logs WHERE action='ENROLL_SUBMIT' ORDER BY id");
  assert.deepEqual(logs.map((l) => l.actor_id), [admin, root]);
  assert.deepEqual(logs.map((l) => JSON.parse(l.detail_json).targetUserId), [employee, second]);
  assert.ok(logs.every((l) => JSON.parse(l.detail_json).submittedByAdmin));
  assert.ok(first.submittedAt);
  assert.equal(first.submittedByName, '人员0');
  assert.equal(enrollment.getMyEnrollment(period, second).submittedByName, '人员1');
  const run = schedule.generate(period, {}, ctx()); assert.equal(run.assignments.length, 4);
  schedule.publish(period, run.runId, ctx());
  assert.equal(schedule.getMyAssignments(employee).length, 2);
});
test('普通员工不能读取或修改代报名；停用与不存在的人员不能成为目标', () => {
  for (const id of [employee, second]) {
    assert.throws(() => enrollment.getAdminEnrollment(period, id, ctx(employee)), (e) => e.status === 403);
    assert.throws(() => enrollment.saveAdminEnrollment(period, id, choices(), ctx(employee)), (e) => e.status === 403);
  }
  assert.throws(() => proxy(9999), (e) => e.status === 404);
  users.updateUser(second, { status: 'disabled' });
  assert.throws(() => proxy(second), /已停用/);
  assert.equal(db.pluck('SELECT COUNT(*) FROM enrollments'), 0);
});
test('本人重新提交和保存草稿后不沿用旧的代报名人', () => {
  periodService.changeStatus(period, 'enrolling', ctx());
  assert.equal(proxy(employee).submittedByName, '人员0');
  const submitted = enrollment.saveEnrollment(period, employee, choices(), ctx(employee));
  assert.ok(submitted.submittedAt);
  assert.equal(submitted.submittedByName, null);

  assert.equal(proxy(employee, 'primary', root).submittedByName, '人员1');
  const draft = enrollment.saveEnrollment(period, employee, { ...choices(), submit: false }, ctx(employee));
  assert.equal(draft.submittedAt, null);
  assert.equal(draft.submittedByName, null);
});
test('更新已有报名时保留请假、可用时间、个人上限及备注，并幂等更新原记录', () => {
  periodService.changeStatus(period, 'enrolling', ctx());
  const original = enrollment.saveEnrollment(period, employee, { ...choices(), maxShifts: 0, note: '已有个人限制', availability: [{ workDate: '2026-11-06', shiftId: shift }], unavailability: [{ workDate: '2026-11-05', reason: '请假' }], submit: true }, ctx(employee));
  const saved = proxy(employee, 'deputy');
  assert.equal(saved.enrollmentId, original.enrollmentId); assert.equal(saved.maxShifts, 0); assert.equal(saved.note, original.note);
  assert.deepEqual(saved.availability, original.availability); assert.deepEqual(saved.unavailability, original.unavailability);
  assert.equal(saved.workTypes[0].dutyRole, 'deputy');
  proxy(employee, 'deputy'); assert.equal(db.pluck('SELECT COUNT(*) FROM enrollments'), 1);
  assert.equal(db.get("SELECT actor_id FROM audit_logs WHERE action='ENROLL_SUBMIT' ORDER BY id DESC").actor_id, admin);
});
test('代报名同样拒绝范围外、停用工作、重复及无效主副角色，失败不留部分数据', () => {
  const other = configs.insertWorkType({ code: 'OTHER', name: '范围外工作' });
  for (const payload of [{ workTypes: [] }, { workTypes: [{ workTypeId: other }] }, choices('member'), choices('invalid'), { workTypes: [...choices().workTypes, ...choices().workTypes] }]) {
    assert.throws(() => enrollment.saveAdminEnrollment(period, employee, payload, ctx()), (e) => e.status === 400);
  }
  configs.updateWorkType(work, { active: 0 }); assert.throws(() => proxy(employee), /不存在或不在本周期/);
  assert.equal(db.pluck('SELECT COUNT(*) FROM enrollments'), 0);
  assert.equal(db.pluck("SELECT COUNT(*) FROM audit_logs WHERE action='ENROLL_SUBMIT'"), 0);
});
test('已有草稿在代报名修改后需重新生成，已发布可继续代报且归档仍锁定', () => {
  proxy(employee, 'primary'); proxy(second, 'deputy');
  const run = schedule.generate(period, {}, ctx());
  proxy(employee, 'both');
  assert.throws(() => schedule.publish(period, run.runId, ctx()), (e) => e.code === 'SCHEDULE_INPUT_CHANGED');
  const fresh = schedule.generate(period, {}, ctx()); schedule.publish(period, fresh.runId, ctx());
  const assignments = schedule.getMyAssignments(employee);
  assert.equal(proxy(employee, 'primary').workTypes[0].dutyRole, 'primary');
  assert.deepEqual(schedule.getMyAssignments(employee), assignments);
  periodService.changeStatus(period, 'archived', ctx());
  assert.throws(() => proxy(employee), (e) => e.code === 'PERIOD_LOCKED');
});

test('已发布周期允许员工、管理员与超级管理员保存及提交本人报名，生效排班保持原样', () => {
  proxy(employee, 'primary'); proxy(second, 'deputy');
  const first = schedule.generate(period, {}, ctx()); schedule.publish(period, first.runId, ctx());
  const originalAssignments = db.all('SELECT * FROM assignments ORDER BY id');
  const originalRuns = db.all('SELECT * FROM schedule_runs ORDER BY id');
  for (const [i, role] of ['employee', 'admin', 'super_admin'].entries()) {
    const id = users.insertUser({ employeeNo: `NEW${i}`, name: `新报名${i}`, role, passwordHash: 'fixture' });
    const payload = { ...choices('both'), maxShifts: 1, note: '发布后报名', availability: [{ workDate: '2026-11-05', shiftId: shift }], unavailability: [{ workDate: '2026-11-06', reason: '请假' }] };
    assert.equal(enrollment.saveEnrollment(period, id, { ...payload, submit: false }, ctx(id)).status, 'draft');
    assert.ok(!enrollment.getEffectiveEnrollments(period).some((e) => e.userId === id));
    const saved = enrollment.saveEnrollment(period, id, { ...payload, submit: true }, ctx(id));
    assert.equal(saved.status, 'submitted'); assert.equal(saved.maxShifts, 1); assert.equal(saved.workTypes[0].dutyRole, 'both');
    const { scheduleChanges, ...details } = saved;
    assert.equal(scheduleChanges.addedCount, 0);
    assert.deepEqual(enrollment.getMyEnrollment(period, id), details);
    assert.ok(schedule.buildScheduleInput(period).employees.some((e) => e.userId === id));
    assert.deepEqual(schedule.getMyAssignments(id), []);
  }
  assert.equal(periods.findPeriod(period).status, 'published');
  assert.deepEqual(db.all('SELECT * FROM assignments ORDER BY id'), originalAssignments);
  assert.deepEqual(db.all('SELECT * FROM schedule_runs ORDER BY id'), originalRuns);
});

test('发布后代报名进入候选，旧草稿不能发布，重新生成并发布后才替换生效安排', () => {
  proxy(employee, 'primary'); proxy(second, 'deputy');
  const first = schedule.generate(period, {}, ctx()); schedule.publish(period, first.runId, ctx());
  const originalAssignments = db.all('SELECT * FROM assignments WHERE run_id=? ORDER BY id', first.runId);
  const newcomer = users.insertUser({ employeeNo: 'NEW_DEPUTY', name: '新副负责人', role: 'employee', passwordHash: 'fixture' });
  const stale = schedule.generate(period, {}, ctx());
  proxy(newcomer, 'deputy');
  enrollment.saveEnrollment(period, second, { ...choices('deputy'), maxShifts: 0, submit: true }, ctx(second));
  assert.throws(() => schedule.publish(period, stale.runId, ctx()), (e) => e.code === 'SCHEDULE_INPUT_CHANGED');
  assert.equal(db.get('SELECT status FROM schedule_runs WHERE id=?', first.runId).status, 'published');
  assert.deepEqual(db.all('SELECT * FROM assignments WHERE run_id=? ORDER BY id', first.runId), originalAssignments);
  const fresh = schedule.generate(period, {}, ctx());
  assert.equal(fresh.assignments.filter((a) => a.userId === newcomer && a.dutyRole === 'deputy').length, 2);
  assert.equal(schedule.getMyAssignments(second).length, 2);
  assert.equal(schedule.getMyAssignments(newcomer).length, 0);
  schedule.publish(period, fresh.runId, ctx());
  assert.equal(schedule.getMyAssignments(newcomer).length, 2);
  assert.equal(schedule.getMyAssignments(second).length, 0);
  assert.equal(periods.findPeriod(period).status, 'published');
});

test('发布后报名仍校验范围与主副资格，可用新报名直接调配，归档及删除后仍禁止报名', () => {
  proxy(employee, 'primary'); proxy(second, 'deputy');
  const run = schedule.generate(period, {}, ctx()); schedule.publish(period, run.runId, ctx());
  const newcomer = users.insertUser({ employeeNo: 'NEW_PRIMARY', name: '新主负责人', role: 'employee', passwordHash: 'fixture' });
  const otherWork = configs.insertWorkType({ code: 'OTHER', name: '范围外工作' });
  for (const payload of [choices('member'), { workTypes: [{ workTypeId: otherWork }] }]) {
    assert.throws(() => enrollment.saveEnrollment(period, newcomer, payload, ctx(newcomer)), (e) => e.status === 400);
    assert.equal(enrollment.getMyEnrollment(period, newcomer).exists, false);
  }
  enrollment.saveEnrollment(period, newcomer, { ...choices('primary'), maxShifts: 1, unavailability: [{ workDate: '2026-11-06' }], submit: true }, ctx(newcomer));
  const source = db.get("SELECT id FROM assignments WHERE run_id=? AND user_id=? AND work_date='2026-11-05'", run.runId, employee);
  const swaps = require('../src/services/swapService');
  assert.equal(swaps.listCandidates(source.id, ctx().user).candidates.find((c) => c.userId === newcomer).canTake, true);
  swaps.reassignByAdmin({ type: 'transfer', fromAssignmentId: source.id, toUserId: newcomer }, ctx());
  assert.equal(schedule.getMyAssignments(newcomer).length, 1);
  periodService.changeStatus(period, 'archived', ctx());
  assert.throws(() => enrollment.saveEnrollment(period, newcomer, choices(), ctx(newcomer)), (e) => e.code === 'PERIOD_LOCKED');
  assert.throws(() => proxy(newcomer), (e) => e.code === 'PERIOD_LOCKED');
  periodService.deletePeriod(period, ctx());
  assert.throws(() => enrollment.saveEnrollment(period, newcomer, choices(), ctx(newcomer)), (e) => e.status === 404);
  assert.throws(() => proxy(newcomer), (e) => e.status === 404);
});
