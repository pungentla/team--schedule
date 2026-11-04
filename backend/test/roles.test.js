'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-roles-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
const db = require('../src/db/db');
const { migrate, truncateAll } = require('../src/db/migrate');
const configs = require('../src/repositories/configRepo');
const users = require('../src/repositories/userRepo');
const periods = require('../src/repositories/periodRepo');
const enrollments = require('../src/services/enrollmentService');
const schedule = require('../src/services/scheduleService');
const periodService = require('../src/services/periodService');
let ids;
const ctx = (id) => ({ user: { id, role: id === ids.admin ? 'admin' : 'employee' }, requestId: 'roles-test' });
function enroll(id, dutyRole) {
  return enrollments.saveEnrollment(ids.period, id, { workTypes: [{ workTypeId: ids.work, priority: 1, dutyRole }], maxShifts: null, submit: true }, ctx(id));
}
function requirement(needCount) {
  return { workDate: '2026-11-05', shiftId: ids.shift, workTypeId: ids.work, needCount };
}

test.beforeEach(() => {
  migrate(); truncateAll();
  const admin = users.insertUser({ employeeNo: 'admin', name: '管理员', passwordHash: 'fixture', role: 'admin' });
  const employees = ['主', '副', '灵活'].map((name, i) => users.insertUser({ employeeNo: `E${i}`, name, passwordHash: 'fixture' }));
  const work = configs.insertWorkType({ code: 'DUTY', name: '值班', requiresRoles: true });
  const shift = configs.insertShift({ code: 'AM', name: '早班', startTime: '08:00', endTime: '12:00', seq: 1 });
  const period = periods.insertPeriod({ name: '测试周期', startDate: '2026-11-05', endDate: '2026-11-05', status: 'enrolling' });
  ids = { admin, employees, work, shift, period };
  periods.insertSlot(period, '2026-11-05', shift);
  periodService.setRequirements(period, [requirement(3)], ctx(admin));
  employees.forEach((id, i) => enroll(id, ['primary', 'deputy', 'both'][i]));
});
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('3 人需求完整经过报名、生成、落库、发布和角色回显', () => {
  assert.equal(enrollments.getMyEnrollment(ids.period, ids.employees[0]).workTypes[0].dutyRole, 'primary');
  const result = schedule.generate(ids.period, { seed: 42 }, ctx(ids.admin));
  const draft = schedule.getSchedule(ids.period, ctx(ids.admin).user);
  assert.equal(draft.assignments.length, 3);
  assert.ok(draft.assignments.some((a) => a.dutyRole === 'primary'));
  assert.ok(draft.assignments.some((a) => a.dutyRole === 'deputy'));
  assert.deepEqual(draft.matrix[0].shifts[0].workTypes[0].roleGaps, []);
  schedule.publish(ids.period, result.runId, ctx(ids.admin));
  const live = schedule.getSchedule(ids.period, ctx(ids.employees[0]).user);
  assert.equal(live.run.status, 'published');
  assert.equal(live.myAssignments[0].dutyRole, 'primary');
});

test('无人报名主负责人时明确缺主，禁止发布且不改周期状态', () => {
  enroll(ids.employees[0], 'deputy'); enroll(ids.employees[2], 'deputy');
  const result = schedule.generate(ids.period, { seed: 42 }, ctx(ids.admin));
  const draft = schedule.getSchedule(ids.period, ctx(ids.admin).user);
  assert.ok(draft.gaps.byDateShift[0].items.some((g) => g.dutyRole === 'primary' && g.reason === 'no_candidate'));
  assert.deepEqual(draft.matrix[0].shifts[0].workTypes[0].roleGaps, ['primary']);
  assert.throws(() => schedule.publish(ids.period, result.runId, ctx(ids.admin)), (e) => e.code === 'ROLE_COVERAGE_MISSING');
  assert.equal(periods.findPeriod(ids.period).status, 'scheduling');
});

test('主副工作需求可为 0 或至少 2 人，历史的 1 人配置也不能绕过生成校验', () => {
  assert.throws(() => periodService.setRequirements(ids.period, [requirement(1)], ctx(ids.admin)), /至少 2/);
  periods.upsertRequirement(ids.period, '2026-11-05', ids.shift, ids.work, 1);
  assert.throws(() => schedule.generate(ids.period, {}, ctx(ids.admin)), /至少为 2/);
});

test('主副报名需明确角色，保存草稿不会被当作合格候选', () => {
  assert.throws(() => enroll(ids.employees[0], 'member'), /选择主负责人/);
  const draft = enrollments.saveEnrollment(ids.period, ids.employees[0], { workTypes: [{ workTypeId: ids.work, priority: 1, dutyRole: 'member' }], submit: false }, ctx(ids.employees[0]));
  assert.equal(draft.status, 'draft');
  assert.throws(() => enroll(ids.employees[0], 'invalid'), /报名角色必须/);
});

test('草稿生成后修改报名角色，需要重新生成才能发布', () => {
  const result = schedule.generate(ids.period, { seed: 42 }, ctx(ids.admin));
  enroll(ids.employees[0], 'deputy');
  assert.throws(() => schedule.publish(ids.period, result.runId, ctx(ids.admin)), (e) => e.code === 'SCHEDULE_INPUT_CHANGED');
});

test('停用的工作不再进入新排班，已有报名不会使其重新出现', () => {
  const normal = configs.insertWorkType({ code: 'NORMAL', name: '普通工作' });
  configs.updateWorkType(ids.work, { active: 0 });
  periods.upsertRequirement(ids.period, '2026-11-05', ids.shift, normal, 1);
  enrollments.saveEnrollment(ids.period, ids.employees[0], { workTypes: [{ workTypeId: normal, priority: 1 }], submit: true }, ctx(ids.employees[0]));
  const result = schedule.generate(ids.period, {}, ctx(ids.admin));
  schedule.publish(ids.period, result.runId, ctx(ids.admin));
  const live = schedule.getSchedule(ids.period, ctx(ids.admin).user);
  assert.deepEqual(live.assignments.map((a) => a.workTypeId), [normal]);
  assert.equal(live.matrix[0].shifts[0].workTypes.length, 1);
});

test('只开放周日的工作按星期规则生成需求，其他日期不能手动填正数', () => {
  periods.updatePeriod(ids.period, { endDate: '2026-11-08' });
  configs.updateWorkType(ids.work, { weekdays: [0], defaultNeed: 3 });
  periodService.generateSlots(ids.period, { defaultNeed: 0 }, ctx(ids.admin));
  periodService.applyWorkRules(ids.period, ctx(ids.admin));
  const matrix = periodService.getRequirementMatrix(ids.period);
  assert.deepEqual(matrix.dates.map((d) => d.shifts[0].requirements[0].needCount), [0, 0, 0, 3]);
  assert.equal(matrix.totalNeeded, 3);
  assert.throws(() => periodService.setRequirements(ids.period, [requirement(3)], ctx(ids.admin)), /不开放/);
  const result = schedule.generate(ids.period, {}, ctx(ids.admin));
  schedule.publish(ids.period, result.runId, ctx(ids.admin));
  const live = schedule.getSchedule(ids.period, ctx(ids.admin).user);
  assert.deepEqual([...new Set(live.assignments.map((a) => a.workDate))], ['2026-11-08']);
});

test('发布后的星期和需求快照不会随工作配置改变', () => {
  const result = schedule.generate(ids.period, {}, ctx(ids.admin));
  schedule.publish(ids.period, result.runId, ctx(ids.admin));
  configs.updateWorkType(ids.work, { weekdays: [0], requiresRoles: false });
  const live = schedule.getSchedule(ids.period, ctx(ids.admin).user);
  assert.equal(live.assignments.length, 3);
  assert.equal(live.matrix[0].shifts[0].workTypes[0].needCount, 3);
  assert.equal(live.matrix[0].shifts[0].workTypes[0].requiresRoles, true);
});
