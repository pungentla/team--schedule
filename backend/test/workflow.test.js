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

test('新建周期一步准备日期班次及默认需求，固定人员自动参与并可直接生成发布', () => {
  configs.insertShift({ code: 'DISABLED', name: '停用班次', startTime: '14:00', endTime: '18:00', seq: 2, active: 0 });
  const p = create();
  const matrix = service.getRequirementMatrix(p.id);
  assert.equal(matrix.dates.length, 7); assert.equal(matrix.shifts.length, 1); assert.equal(matrix.totalNeeded, 1);
  assert.equal(matrix.dates.find((d) => d.workDate === '2026-11-15').shifts[0].requirements[0].needCount, 1);
  assert.equal(matrix.dates[0].shifts[0].requirements[0].needCount, 0);
  const ready = getPreparation(p.id);
  assert.equal(ready.canGenerate, true); assert.equal(ready.fixedCount, 1); assert.equal(ready.submittedCount, 0);
  assert.equal(ready.nextStep, 'people'); assert.equal(p.status, 'draft');
  const run = schedule.generate(p.id, {}, ctx()); schedule.publish(p.id, run.runId, ctx());
  assert.equal(getPreparation(p.id).nextStep, 'generate');
});
test('初始化旧周期补齐缺失需求，重复执行保留手工人数及显式0，不重置已有工作日规则', () => {
  const p = create({ initializeRequirements: false });
  assert.equal(periods.listSlots(p.id).length, 0); assert.equal(getPreparation(p.id).nextStep, 'requirements');
  service.prepareRequirements(p.id, ctx());
  service.setRequirements(p.id, [{ workDate: '2026-11-15', shiftId: shift, workTypeId: work, needCount: 0 }], ctx());
  service.prepareRequirements(p.id, ctx());
  assert.equal(service.getRequirementMatrix(p.id).totalNeeded, 0);
  assert.equal(getPreparation(p.id).canGenerate, false);
  service.setRequirements(p.id, [{ workDate: '2026-11-15', shiftId: shift, workTypeId: work, needCount: 4 }], ctx());
  service.prepareRequirements(p.id, ctx());
  assert.equal(service.getRequirementMatrix(p.id).totalNeeded, 4);
  service.changeStatus(p.id, 'archived', ctx());
  assert.throws(() => service.prepareRequirements(p.id, ctx()), (e) => e.code === 'PERIOD_LOCKED');
  assert.equal(getPreparation(p.id).canGenerate, false);
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
  enrollment.saveEnrollment(p.id, employee, { workTypes: [{ workTypeId: work, priority: 1 }], submit: true }, { user: { id: employee, role: 'employee' } });
  const ready = getPreparation(p.id);
  assert.equal(ready.canGenerate, true); assert.equal(ready.submittedCount, 1); assert.equal(ready.fixedCount, 0);
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
