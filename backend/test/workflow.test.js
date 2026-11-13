'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-workflow-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
const db = require('../src/db/db');
const { migrate, truncateAll } = require('../src/db/migrate');
const periods = require('../src/repositories/periodRepo');
const users = require('../src/repositories/userRepo');
const configs = require('../src/repositories/configRepo');
const service = require('../src/services/periodService');
const { getPreparation } = require('../src/services/periodWorkflowService');
const enrollment = require('../src/services/enrollmentService');
const schedule = require('../src/services/scheduleService');
const { updatePublishedWork } = require('../src/services/publishedWorkService');
const swaps = require('../src/services/swapService');
let admin, employee, shift, work;
const ctx = () => ({ user: { id: admin, role: 'super_admin' }, requestId: 'workflow-test' });
const create = (extra = {}) => service.createPeriod({ name: '流程验证', startDate: '2026-11-09', endDate: '2026-11-15', initializeRequirements: true, ...extra }, ctx());
test.beforeEach(() => {
  migrate(); truncateAll();
  admin = users.insertUser({ employeeNo: 'ADMIN', name: '管理员', passwordHash: 'fixture', role: 'super_admin' });
  employee = users.insertUser({ employeeNo: 'EMPLOYEE', name: '员工', passwordHash: 'fixture' });
  shift = configs.insertShift({ code: 'DAY', name: '日班', startTime: '08:00', endTime: '12:00', seq: 1 });
  work = configs.insertWorkType({ code: 'WORK', name: '周日工作', weekdays: [0], defaultNeed: 1, weeklyAssignments: [{ weekday: 0, shiftId: shift, userId: employee, dutyRole: 'member' }] });
});
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('跨周期参考历史时周日工作优先轮到其他报名人，只有一人符合时仍可安排', () => {
  configs.updateWorkType(work, { weeklyAssignments: [] });
  const previous = create({ startDate: '2026-11-08', endDate: '2026-11-08' });
  const workTypes = [{ workTypeId: work }];
  enrollment.saveAdminEnrollment(previous.id, employee, { workTypes }, ctx());
  const oldRun = schedule.generate(previous.id, {}, ctx());
  schedule.publish(previous.id, oldRun.runId, ctx());

  const third = users.insertUser({ employeeNo: 'OTHER', name: '另一位员工', passwordHash: 'fixture' });
  const current = create({ startDate: '2026-11-15', endDate: '2026-11-29' });
  for (const person of [employee, admin, third]) enrollment.saveAdminEnrollment(current.id, person, { workTypes }, ctx());
  const withHistory = schedule.generate(current.id, { referenceHistory: true }, ctx());
  assert.deepEqual(new Set(withHistory.assignments.slice(0, 2).map(assignment => assignment.userId)), new Set([admin, third]));
  assert.equal(withHistory.assignments[2].userId, employee);
  assert.equal(schedule.getSchedule(current.id, ctx().user, { runId: withHistory.runId }).run.referenceHistory, true);
  for (const person of [admin, third]) db.run('UPDATE enrollments SET max_shifts=0 WHERE period_id=? AND user_id=?', current.id, person);
  const fallback = schedule.generate(current.id, { referenceHistory: true }, ctx());
  assert.equal(fallback.assignments.length, 3);
  assert.ok(fallback.assignments.every(assignment => assignment.userId === employee));
  const withoutHistory = schedule.generate(current.id, { referenceHistory: false }, ctx());
  assert.equal(withoutHistory.assignments.length, 3);
  assert.equal(schedule.getSchedule(current.id, ctx().user, { runId: withoutHistory.runId }).run.referenceHistory, false);
  assert.equal(schedule.publish(current.id, withoutHistory.runId, ctx()).filled, 3);
});

test('生效工作可补人但需求人数不变，满员后拒绝继续补人', () => {
  const period = create();
  const draft = schedule.generate(period.id, {}, ctx());
  const preview = schedule.getSchedule(period.id, ctx().user, { runId: draft.runId });
  schedule.adjustDraft(draft.runId, { action: 'remove', assignmentId: preview.assignments[0].id }, ctx());
  schedule.publish(period.id, draft.runId, ctx());
  const published = () => schedule.getSchedule(period.id, ctx().user, { runId: draft.runId });
  const before = published();
  const change = {
    action: 'fill', revision: before.run.revision, workDate: '2026-11-15', shiftId: shift, workTypeId: work,
    people: [{ userId: employee, dutyRole: 'member' }],
  };
  const result = updatePublishedWork(draft.runId, change, ctx());
  const after = published();
  assert.equal(after.run.totalNeeded, before.run.totalNeeded);
  assert.equal(after.run.totalFilled, 1);
  assert.equal(after.matrix[0].shifts[0].workTypes[0].gap, 0);
  assert.throws(() => updatePublishedWork(draft.runId, { ...change, revision: result.revision }, ctx()), error => error.code === 'PUBLISHED_WORK_FULL');
});

test('手动增删生效工作同步安排、需求快照和待确认换班', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-11T04:00:00Z') });
  const extraWork = configs.insertWorkType({ code: 'EXTRA', name: '加开工作', defaultNeed: 0 });
  const period = create();
  const target = { workDate: '2026-11-15', shiftId: shift, workTypeId: extraWork };
  for (const person of [employee, admin]) enrollment.saveAdminEnrollment(period.id, person, { workTypes: [{ workTypeId: extraWork }] }, ctx());
  const { runId } = schedule.generate(period.id, {}, ctx());
  schedule.publish(period.id, runId, ctx());
  const current = () => schedule.getSchedule(period.id, ctx().user, { runId });
  const original = current();
  const added = updatePublishedWork(runId, { ...target, action: 'add', revision: original.run.revision,
    people: [{ userId: employee, dutyRole: 'member' }] }, ctx());
  const withWork = current();
  const assignment = withWork.assignments.find(item => item.workTypeId === extraWork);
  assert.equal(assignment.source, 'manual');
  assert.equal(withWork.run.totalNeeded, original.run.totalNeeded + 1);
  assert.equal(withWork.run.totalFilled, original.run.totalFilled + 1);
  assert.ok(withWork.metrics.perWorkType.some(item => item.workTypeId === extraWork));
  assert.throws(() => updatePublishedWork(runId, { ...target, action: 'remove', revision: original.run.revision }, ctx()), error => error.code === 'PUBLISHED_CHANGED');
  const swap = swaps.createSwap({ type: 'transfer', fromAssignmentId: assignment.id, toUserId: admin },
    { user: users.publicUser(users.findById(employee)), requestId: 'published-work-test' }).swap;
  updatePublishedWork(runId, { ...target, action: 'remove', revision: added.revision }, ctx());
  const after = current();
  assert.deepEqual(after.assignments, original.assignments);
  assert.equal(after.run.totalNeeded, original.run.totalNeeded);
  assert.equal(after.run.totalFilled, original.run.totalFilled);
  assert.equal(db.pluck('SELECT status FROM swap_requests WHERE id=?', swap.id), 'cancelled');
  assert.equal(db.pluck('SELECT status FROM assignments WHERE id=?', assignment.id), 'released');
  assert.ok(!after.metrics.perWorkType.some(item => item.workTypeId === extraWork));
});

test('新建周期一步准备日期班次及默认需求，固定人员自动参与并可直接生成发布', () => {
  configs.insertShift({ code: 'DISABLED', name: '停用班次', startTime: '14:00', endTime: '18:00', seq: 2, active: 0 });
  configs.updateWorkType(work, { defaultNeed: 0 });
  const p = create();
  const matrix = service.getRequirementMatrix(p.id);
  assert.equal(matrix.matchesDefaultRules, true);
  assert.equal(matrix.dates.length, 7); assert.equal(matrix.shifts.length, 1); assert.equal(matrix.totalNeeded, 1);
  assert.equal(matrix.dates.find((d) => d.workDate === '2026-11-15').shifts[0].requirements[0].needCount, 1);
  assert.equal(matrix.dates[0].shifts[0].requirements[0].needCount, 0);
  const ready = getPreparation(p.id);
  assert.equal(ready.canGenerate, true); assert.equal(ready.fixedCount, 1); assert.equal(ready.submittedCount, 0);
  assert.deepEqual(ready.participants[0].workTypes, [{ id: work, name: '周日工作', fixedOnly: true }]);
  assert.equal(ready.participants[0].submittedAt, null);
  assert.equal(ready.nextStep, 'people'); assert.equal(p.status, 'draft');
  const run = schedule.generate(p.id, {}, ctx()); schedule.publish(p.id, run.runId, ctx());
  assert.equal(getPreparation(p.id).nextStep, 'generate');
  const before = schedule.getSchedule(p.id, ctx().user, { runId: run.runId });
  assert.throws(() => service.updatePeriod(p.id, { name: '不能同时调整', endDate: '2026-11-16' }, ctx()), (e) => e.code === 'PERIOD_LOCKED');
  const renamed = service.updatePeriod(p.id, { name: '已发布后改名' }, ctx());
  assert.deepEqual([renamed.name, renamed.status, renamed.endDate], ['已发布后改名', 'published', p.endDate]);
  const after = schedule.getSchedule(p.id, ctx().user, { runId: run.runId });
  assert.deepEqual(after.run, before.run);
  assert.deepEqual(after.assignments, before.assignments);
  assert.equal(getPreparation(p.id).period.name, renamed.name);
  service.changeStatus(p.id, 'archived', ctx());
  assert.equal(service.updatePeriod(p.id, { name: '归档后改名' }, ctx()).name, '归档后改名');
  assert.throws(() => service.updatePeriod(p.id, { maxShiftsPerDay: 2 }, ctx()), (e) => e.code === 'PERIOD_LOCKED');
});
test('初始化旧周期补齐缺失需求，重复执行保留手工人数及显式0，不重置已有工作日规则', () => {
  const p = create({ initializeRequirements: false });
  assert.equal(periods.listSlots(p.id).length, 0); assert.equal(getPreparation(p.id).nextStep, 'requirements');
  assert.equal(service.getRequirementMatrix(p.id).matchesDefaultRules, false);
  service.prepareRequirements(p.id, ctx());
  service.setRequirements(p.id, [{ workDate: '2026-11-15', shiftId: shift, workTypeId: work, needCount: 0 }], ctx());
  service.prepareRequirements(p.id, ctx());
  assert.equal(service.getRequirementMatrix(p.id).totalNeeded, 0);
  assert.equal(service.getRequirementMatrix(p.id).matchesDefaultRules, false);
  assert.equal(getPreparation(p.id).canGenerate, false);
  service.setRequirements(p.id, [{ workDate: '2026-11-15', shiftId: shift, workTypeId: work, needCount: 4 }], ctx());
  service.prepareRequirements(p.id, ctx());
  assert.equal(service.getRequirementMatrix(p.id).totalNeeded, 4);
  service.changeStatus(p.id, 'archived', ctx());
  assert.throws(() => service.prepareRequirements(p.id, ctx()), (e) => e.code === 'PERIOD_LOCKED');
  assert.equal(getPreparation(p.id).canGenerate, false);
});
test('生成草稿后不能切回报名中，仍可归档', () => {
  const p = create();
  service.changeStatus(p.id, 'enrolling', ctx());
  service.changeStatus(p.id, 'scheduling', ctx());
  assert.equal(service.changeStatus(p.id, 'enrolling', ctx()).status, 'enrolling');

  const run = schedule.generate(p.id, {}, ctx());
  assert.throws(() => service.changeStatus(p.id, 'enrolling', ctx()), (e) => e.code === 'PERIOD_HAS_DRAFT');
  assert.equal(periods.findPeriod(p.id).status, 'scheduling');
  assert.equal(getPreparation(p.id).draftRunId, run.runId);
  periods.updatePeriod(p.id, { status: 'enrolling' });
  assert.equal(service.listPeriods({ includeDraftStatus: true })[0].hasDraft, true);
  assert.equal(service.listPeriods()[0].hasDraft, undefined);
  assert.throws(() => service.changeStatus(p.id, 'draft', ctx()), (e) => e.code === 'PERIOD_HAS_DRAFT');
  assert.equal(service.changeStatus(p.id, 'archived', ctx()).status, 'archived');
});
test('缺少基础配置或初始化中途失败时，不留下半成品周期和日期需求', () => {
  configs.updateShift(shift, { active: 0 });
  assert.throws(() => create(), /启用至少一个工作和班次/);
  assert.equal(db.pluck('SELECT COUNT(*) FROM periods'), 0);
  configs.updateShift(shift, { active: 1 });
  const original = periods.upsertRequirement;
  let calls = 0;
  periods.upsertRequirement = (...args) => { if (++calls === 2) throw new Error('模拟写入失败'); return original(...args); };
  try { assert.throws(() => create(), /模拟写入失败/); } finally { periods.upsertRequirement = original; }
  assert.equal(db.pluck('SELECT COUNT(*) FROM periods'), 0); assert.equal(db.pluck('SELECT COUNT(*) FROM period_slots'), 0);
  assert.equal(db.pluck('SELECT COUNT(*) FROM slot_requirements'), 0); assert.equal(db.pluck('SELECT COUNT(*) FROM audit_logs'), 0);
});
test('准备检查只统计匹配实际需求的人员，其他工作报名和不匹配星期的固定名单不算就绪', () => {
  configs.updateWorkType(work, { weeklyAssignments: [{ weekday: 1, shiftId: shift, userId: employee, dutyRole: 'member' }] });
  const p = create();
  assert.equal(getPreparation(p.id).canGenerate, false); assert.equal(getPreparation(p.id).nextStep, 'people');
  const other = configs.insertWorkType({ code: 'OTHER', name: '其他工作', defaultNeed: 0 });
  service.changeStatus(p.id, 'enrolling', ctx());
  enrollment.saveEnrollment(p.id, employee, { workTypes: [{ workTypeId: other, priority: 1 }], submit: true }, { user: { id: employee, role: 'employee' } });
  assert.equal(getPreparation(p.id).participants.length, 0);
  const submitted = enrollment.saveEnrollment(p.id, employee, { workTypes: [{ workTypeId: work, priority: 1 }, { workTypeId: other, priority: 2 }], submit: true }, { user: { id: employee, role: 'employee' } });
  const ready = getPreparation(p.id);
  assert.equal(ready.canGenerate, true); assert.equal(ready.submittedCount, 1); assert.equal(ready.fixedCount, 0);
  assert.deepEqual(ready.participants[0].workTypes, [
    { id: work, name: '周日工作', fixedOnly: false },
    { id: other, name: '其他工作', fixedOnly: false },
  ]);
  assert.equal(ready.participants[0].submittedAt, submitted.submittedAt);
});
test('就绪检查过滤停用工作、停用班次和无效主副人数，固定与普通报名去重', () => {
  const p = create();
  service.changeStatus(p.id, 'enrolling', ctx());
  enrollment.saveEnrollment(p.id, employee, { workTypes: [{ workTypeId: work, priority: 1 }], submit: true }, { user: { id: employee, role: 'employee' } });
  assert.equal(getPreparation(p.id).participants.length, 1);
  assert.equal(getPreparation(p.id).fixedCount, 1); assert.equal(getPreparation(p.id).submittedCount, 1);
  configs.updateWorkType(work, { requiresRoles: true });
  const invalid = getPreparation(p.id);
  assert.equal(invalid.canGenerate, false); assert.ok(invalid.blockers.some((b) => b.message.includes('至少为 2')));
  configs.updateWorkType(work, { active: 0 });
  assert.equal(getPreparation(p.id).totalNeeded, 0); assert.equal(getPreparation(p.id).participants.length, 0);
  configs.updateShift(shift, { active: 0 });
  assert.equal(getPreparation(p.id).slotCount, 0);
  assert.equal(service.getRequirementMatrix(p.id).dates.length, 0);
});

test('本周期仅带入勾选工作和班次，需求、报名、生成、发布都遵守保存的选择', () => {
  const otherWork = configs.insertWorkType({ code: 'OTHER', name: '未选工作', defaultNeed: 3 });
  const otherShift = configs.insertShift({ code: 'EVENING', name: '未选班次', startTime: '16:00', endTime: '20:00', seq: 2 });
  const p = create({ workTypeIds: [work], shiftIds: [shift] });
  assert.deepEqual(p.workTypeIds, [work]); assert.deepEqual(p.shiftIds, [shift]);
  const matrix = service.getRequirementMatrix(p.id);
  assert.deepEqual(matrix.workTypes.map((w) => w.id), [work]); assert.deepEqual(matrix.shifts.map((s) => s.shiftId), [shift]);
  assert.equal(matrix.totalNeeded, 1); assert.equal(periods.listSlots(p.id).length, 7);
  const context = enrollment.getEnrollContext(p.id, employee);
  assert.deepEqual(context.workTypes.map((w) => w.id), [work]); assert.deepEqual(context.shifts.map((s) => s.id), [shift]);
  assert.throws(() => service.setRequirements(p.id, [{ workDate: '2026-11-15', shiftId: shift, workTypeId: otherWork, needCount: 1 }], ctx()), /选择范围/);
  assert.throws(() => service.generateSlots(p.id, { shiftIds: [otherShift], defaultNeed: 1 }, ctx()), /选择范围/);
  service.changeStatus(p.id, 'enrolling', ctx());
  assert.throws(() => enrollment.saveEnrollment(p.id, employee, { workTypes: [{ workTypeId: otherWork, priority: 1 }], submit: true }, ctx()), /选择范围/);
  assert.throws(() => enrollment.saveEnrollment(p.id, employee, { workTypes: [{ workTypeId: work, priority: 1 }], availability: [{ workDate: '2026-11-15', shiftId: otherShift }], submit: true }, ctx()), /选择范围/);
  const run = schedule.generate(p.id, {}, ctx());
  assert.equal(run.assignments.length, 1); assert.equal(run.assignments[0].workTypeId, work); assert.equal(run.assignments[0].shiftId, shift);
  schedule.publish(p.id, run.runId, ctx());
});
test('重新初始化、默认规则重填和后续新增基础配置不会重新加入未选项目', () => {
  const p = create({ workTypeIds: [work], shiftIds: [shift] });
  const newWork = configs.insertWorkType({ code: 'NEW', name: '后来增加的工作', defaultNeed: 5 });
  const newShift = configs.insertShift({ code: 'NEW', name: '后来增加的班次', startTime: '16:00', endTime: '20:00', seq: 2 });
  service.applyWorkRules(p.id, ctx()); service.prepareRequirements(p.id, ctx());
  service.generateSlots(p.id, { defaultNeed: 1 }, ctx());
  assert.equal(periods.listSlots(p.id).length, 7);
  const reqs = periods.listRequirements(p.id);
  assert.equal(reqs.length, 1); assert.ok(reqs.every((r) => r.work_type_id !== newWork && r.shift_id !== newShift));
  assert.equal(getPreparation(p.id).workTypeCount, 1); assert.equal(getPreparation(p.id).shiftCount, 1);
});
test('本次选择拒绝空数组、重复、未知或停用项目，不创建半成品周期', () => {
  for (const field of ['workTypeIds', 'shiftIds']) {
    for (const value of [[], [9999], [field === 'workTypeIds' ? work : shift, field === 'workTypeIds' ? work : shift]]) {
      assert.throws(() => create({ [field]: value }), (e) => e.status === 400);
    }
  }
  configs.updateWorkType(work, { active: 0 });
  assert.throws(() => create({ workTypeIds: [work], shiftIds: [shift] }), /已停用/);
  assert.equal(db.pluck('SELECT COUNT(*) FROM periods'), 0);
});
test('旧客户端未传选择仍保持全部启用项，v5 数据迁移保留原周期范围', () => {
  const other = configs.insertWorkType({ code: 'OTHER', name: '原有其他工作', defaultNeed: 1 });
  const p = create();
  assert.equal(p.workTypeIds, null); assert.equal(p.shiftIds, null);
  assert.ok(service.getRequirementMatrix(p.id).workTypes.some((w) => w.id === other));
  const before = periods.listRequirements(p.id);
  db.exec('ALTER TABLE periods DROP COLUMN work_type_ids_json; ALTER TABLE periods DROP COLUMN shift_ids_json; PRAGMA user_version=5;');
  migrate();
  const dto = periods.toPeriodDto(periods.findPeriod(p.id));
  assert.equal(dto.workTypeIds, null); assert.equal(dto.shiftIds, null);
  assert.deepEqual(periods.listRequirements(p.id), before);
});
