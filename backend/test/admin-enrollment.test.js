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
test('已有草稿在代报名修改角色后需重新生成，已发布或归档周期不能修改报名', () => {
  proxy(employee, 'primary'); proxy(second, 'deputy');
  const run = schedule.generate(period, {}, ctx());
  proxy(employee, 'both');
  assert.throws(() => schedule.publish(period, run.runId, ctx()), (e) => e.code === 'SCHEDULE_INPUT_CHANGED');
  const fresh = schedule.generate(period, {}, ctx()); schedule.publish(period, fresh.runId, ctx());
  const before = enrollment.getMyEnrollment(period, employee);
  assert.throws(() => proxy(employee, 'deputy'), (e) => e.code === 'PERIOD_LOCKED');
  assert.deepEqual(enrollment.getMyEnrollment(period, employee), before);
  periodService.changeStatus(period, 'archived', ctx());
  assert.throws(() => proxy(employee), (e) => e.code === 'PERIOD_LOCKED');
});
