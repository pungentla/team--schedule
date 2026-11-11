'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-live-enroll-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
const db = require('../src/db/db');
const { migrate, truncateAll, CURRENT_VERSION } = require('../src/db/migrate');
const users = require('../src/repositories/userRepo');
const configs = require('../src/repositories/configRepo');
const periods = require('../src/services/periodService');
const periodRepo = require('../src/repositories/periodRepo');
const enroll = require('../src/services/enrollmentService');
const schedule = require('../src/services/scheduleService');
const swaps = require('../src/services/swapService');
const { dateRange } = require('../src/utils/date');
let admin, owner, deputy, worker, newcomer, a, b, c, am, pm, evening, period, run;
const ctx = (id = owner) => ({ user: users.publicUser(users.findById(id)), requestId: 'live-enroll-test' });
const choices = (ids, role = 'primary') => ids.map((id) => ({ workTypeId: id, dutyRole: id === a ? role : 'member', priority: 1 }));
const submit = (id, ids, extra = {}) => enroll.saveEnrollment(period, id, { workTypes: choices(ids), submit: true, ...extra }, ctx(id));
const active = () => db.all("SELECT * FROM assignments WHERE run_id=? AND status='active' ORDER BY id", run);
const live = () => schedule.getSchedule(period, ctx(admin).user, { version: 'published' });
function pendingTransfer() {
  enroll.saveAdminEnrollment(period, admin, { workTypes: choices([a]) }, ctx(admin));
  const source = db.get("SELECT id FROM assignments WHERE run_id=? AND user_id=? AND work_type_id=? AND work_date='2026-11-05'", run, owner, a);
  return swaps.createSwap({ type: 'transfer', fromAssignmentId: source.id, toUserId: admin }, ctx()).swap.id;
}
test.beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T04:00:00Z') });
  migrate(); truncateAll();
  [admin, owner, deputy, worker, newcomer] = ['super_admin', 'employee', 'employee', 'employee', 'employee'].map((role, i) => users.insertUser({ employeeNo: `U${i}`, name: `人员${i}`, role, passwordHash: 'fixture' }));
  am = configs.insertShift({ code: 'AM', name: '上午', startTime: '08:00', endTime: '12:00', seq: 1 });
  pm = configs.insertShift({ code: 'PM', name: '下午', startTime: '13:00', endTime: '17:00', seq: 2 });
  evening = configs.insertShift({ code: 'EV', name: '晚上', startTime: '18:00', endTime: '20:00', seq: 3 });
  a = configs.insertWorkType({ code: 'A', name: '主副工作', requiresRoles: true, defaultNeed: 2 });
  b = configs.insertWorkType({ code: 'B', name: '其他工作', defaultNeed: 1 });
  c = configs.insertWorkType({ code: 'C', name: '空位工作', defaultNeed: 2 });
  period = periods.createPeriod({ name: '跨日周期', startDate: '2026-11-02', endDate: '2026-11-12', workTypeIds: [a, b, c], shiftIds: [am, pm, evening], maxShiftsPerDay: 3, maxShiftsPerWeek: 21, forbidConsecutive: false, initializeRequirements: true }, ctx(admin)).id;
  const needs = dateRange('2026-11-02', '2026-11-12').flatMap((workDate) => [am, pm, evening].flatMap((shiftId) => [a, b, c].map((workTypeId) => ({ workDate, shiftId, workTypeId, needCount: workTypeId === a && shiftId === am ? 2 : workTypeId === b && shiftId === pm ? 1 : workTypeId === c && shiftId === evening ? 2 : 0 }))));
  periods.setRequirements(period, needs, ctx(admin));
  for (const [id, ids, role] of [[owner, [a, b], 'primary'], [deputy, [a], 'deputy'], [worker, [c], 'member']]) enroll.saveAdminEnrollment(period, id, { workTypes: choices(ids, role) }, ctx(admin));
  run = schedule.generate(period, {}, ctx(admin)).runId;
  schedule.publish(period, run, ctx(admin));
  assert.equal(active().length, 44);
});
test.afterEach((t) => t.mock.timers.reset());
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('新报名只填今天起7天的真实空位，不动已有人员、过去或第8天之后的安排', () => {
  const original = active();
  const result = submit(newcomer, [c]);
  assert.equal(result.scheduleChanges.addedCount, 7); assert.equal(result.scheduleChanges.removedCount, 0);
  const added = active().filter((r) => r.user_id === newcomer);
  assert.deepEqual(added.map((r) => r.work_date), dateRange('2026-11-04', '2026-11-10'));
  assert.ok(added.every((r) => r.work_type_id === c && r.shift_id === evening));
  assert.deepEqual(active().filter((r) => r.user_id !== newcomer), original);
  assert.equal(live().run.id, run); assert.equal(live().run.revision, 1);
  assert.equal(live().run.totalFilled, 51); assert.equal(live().gaps.totalGap, 4);
  assert.equal(live().gaps.byEmployee.find((e) => e.userId === newcomer).assigned, 7);
  assert.equal(schedule.getRecentSchedule(newcomer).assignments.length, 7);
  const repeated = submit(newcomer, [c]); assert.equal(repeated.scheduleChanges.addedCount, 0); assert.equal(live().run.revision, 1);
});

test('按星期报名只补所选星期的空位，取消星期只释放本周期未来对应班次', () => {
  const original = active();
  const work = choices([c])[0];
  const configService = require('../src/services/configService');
  assert.throws(() => submit(newcomer, [c], { workTypes: [{ ...work, weekdays: [0] }] }), /未开放自选报名星期/);
  assert.equal(configService.updateWorkType(c, { allowWeekdaySelection: true }, ctx(admin)).allowWeekdaySelection, true);
  const result = submit(newcomer, [c], { workTypes: [{ ...work, weekdays: [0, 4] }] });
  assert.deepEqual(result.workTypes[0].weekdays, [0, 4]);
  assert.equal(result.scheduleChanges.addedCount, 2);
  assert.deepEqual(active().filter(r => r.user_id === newcomer).map(r => r.work_date), ['2026-11-05', '2026-11-08']);

  const narrowed = submit(newcomer, [c], { workTypes: [{ ...work, weekdays: [0] }] });
  assert.equal(narrowed.scheduleChanges.removedCount, 1);
  assert.equal(narrowed.scheduleChanges.addedCount, 0);
  assert.deepEqual(active().filter(r => r.user_id === newcomer).map(r => r.work_date), ['2026-11-08']);
  assert.deepEqual(active().filter(r => r.user_id !== newcomer), original);
  assert.equal(configService.updateWorkType(c, { allowWeekdaySelection: false }, ctx(admin)).allowWeekdaySelection, false);
  assert.throws(() => submit(newcomer, [c], { workTypes: [{ ...work, weekdays: [4] }] }), /未开放自选报名星期/);
  assert.deepEqual(submit(newcomer, [c]).workTypes[0].weekdays, [0]);
});

test('不同工作分别按报名星期排班，旧固定名单不会覆盖本人选择', () => {
  configs.updateWorkType(a, { allowWeekdaySelection: true });
  configs.updateWorkType(b, { allowWeekdaySelection: true, weeklyAssignments: [{ weekday: 1, shiftId: pm, userId: owner, dutyRole: 'member' }] });
  const workTypes = choices([a, b]).map(work => ({ ...work, weekdays: work.workTypeId === a ? [1] : [0] }));
  assert.throws(() => submit(owner, [b], { workTypes: [{ ...workTypes[1], weekdays: [7] }] }), /选择开放工作日/);
  assert.throws(() => submit(owner, [b], { workTypes: [{ ...workTypes[1], weekdays: [] }] }), /报名星期/);
  submit(owner, [a, b], { workTypes });

  const draft = schedule.generate(period, {}, ctx(admin));
  const own = db.all('SELECT work_type_id, work_date FROM assignments WHERE run_id=? AND user_id=?', draft.runId, owner);
  assert.deepEqual(own.filter(r => r.work_type_id === a).map(r => r.work_date).sort(), ['2026-11-02', '2026-11-09']);
  assert.deepEqual(own.filter(r => r.work_type_id === b).map(r => r.work_date), ['2026-11-08']);
  assert.deepEqual(draft.gaps.fixedConflicts, []);
});

for (const byAdmin of [false, true]) test(`${byAdmin ? '管理员代办' : '本人'}取消工作：只移除明天起本周期该工作的安排，撤回受影响换班并同步主副缺口`, () => {
  const swapId = pendingTransfer();
  const original = active();
  const oldOtherGap = live().gaps.byDateShift.find((d) => d.workDate === '2026-11-05' && d.shiftId === evening).items[0];
  const result = byAdmin ? enroll.saveAdminEnrollment(period, owner, { workTypes: choices([b]) }, ctx(admin)) : submit(owner, [b]);
  assert.equal(result.scheduleChanges.removedCount, 8); assert.equal(result.scheduleChanges.cancelledSwapCount, 1); assert.equal(result.scheduleChanges.addedCount, 0);
  const kept = original.filter((r) => !(r.user_id === owner && r.work_type_id === a && r.work_date > '2026-11-04'));
  assert.deepEqual(active(), kept);
  assert.equal(db.pluck("SELECT COUNT(*) FROM assignments WHERE run_id=? AND status='released' AND released_at IS NOT NULL", run), 8);
  assert.equal(db.get('SELECT status FROM swap_requests WHERE id=?', swapId).status, 'cancelled');
  assert.equal(swaps.getPendingCount(admin), 0);
  assert.throws(() => swaps.confirm(swapId, ctx(admin)), (e) => e.code === 'ALREADY_DECIDED');
  const view = live(); assert.equal(view.run.totalFilled, 36); assert.equal(view.gaps.totalGap, 19); assert.equal(view.run.revision, 1);
  assert.deepEqual(view.matrix.find((d) => d.workDate === '2026-11-05').shifts.find((s) => s.shiftId === am).workTypes[0].roleGaps, ['primary']);
  assert.equal(view.gaps.byDateShift.find((d) => d.workDate === '2026-11-05' && d.shiftId === evening).items[0].reason, oldOtherGap.reason);
  const logs = db.all("SELECT actor_id,detail_json FROM audit_logs WHERE action='ASSIGNMENT_MANUAL'");
  assert.equal(logs.length, 8); assert.ok(logs.every((l) => l.actor_id === (byAdmin ? admin : owner) && JSON.parse(l.detail_json).action === 'enrollment_withdrawal'));
});

test('先保存空草稿再正式取消全部报名仍正确清理，重复提交幂等，新增空报名仍拒绝', () => {
  const original = active();
  const draft = submit(owner, [], { submit: false });
  assert.equal(draft.status, 'draft'); assert.deepEqual(draft.submittedWorkTypeIds, [a, b]); assert.deepEqual(active(), original);
  const result = submit(owner, []); assert.equal(result.scheduleChanges.removedCount, 16);
  assert.equal(active().filter((r) => r.user_id === owner).length, 6);
  const repeated = submit(owner, []); assert.equal(repeated.scheduleChanges.removedCount, 0); assert.equal(live().run.revision, 1);
  assert.deepEqual(enroll.getMyEnrollment(period, owner).withdrawnWorkTypeIds, [a, b]);
  assert.throws(() => submit(newcomer, []), (e) => e.status === 400);
});

test('北京时间跨零点后重新计算明天，今天的安排始终保留', (t) => {
  t.mock.timers.setTime(new Date('2026-11-04T15:59:00Z').getTime());
  assert.equal(submit(owner, [b]).scheduleChanges.afterDate, '2026-11-04');
  t.mock.timers.tick(120000);
  const result = submit(owner, []); assert.equal(result.scheduleChanges.afterDate, '2026-11-05'); assert.equal(result.scheduleChanges.removedCount, 7);
  assert.deepEqual(active().filter((r) => r.user_id === owner && r.work_type_id === b).map((r) => r.work_date), dateRange('2026-11-02', '2026-11-05'));
});

test('只补合格负责人，遵守请假、可用班次与累计上限，不以额外副负责人占掉必需主负责人空位', () => {
  submit(owner, [b]);
  assert.equal(submit(newcomer, [a], { workTypes: choices([a], 'deputy') }).scheduleChanges.addedCount, 0);
  const original = active();
  const result = submit(newcomer, [a], { maxShifts: 1, availability: [{ workDate: '2026-11-06', shiftId: am }], unavailability: [{ workDate: '2026-11-05' }] });
  assert.equal(result.scheduleChanges.addedCount, 1);
  assert.deepEqual(active().filter((r) => r.user_id !== newcomer), original);
  const added = active().filter((r) => r.user_id === newcomer); assert.equal(added[0].work_date, '2026-11-06'); assert.equal(added[0].duty_role, 'primary');
  assert.equal(submit(newcomer, [a, c], { maxShifts: 1 }).scheduleChanges.addedCount, 0);
});

test('统计刷新失败时，报名、自动补位、取消排班和相关换班一起回滚', () => {
  const swapId = pendingTransfer();
  const original = active(); const oldRun = db.get('SELECT * FROM schedule_runs WHERE id=?', run); const oldMine = enroll.getMyEnrollment(period, owner);
  const refresh = swaps.refreshRunMetrics;
  swaps.refreshRunMetrics = () => { throw Error('模拟统计失败'); };
  try {
    assert.throws(() => submit(owner, [b, c]), /模拟统计失败/);
    assert.deepEqual(active(), original); assert.deepEqual(enroll.getMyEnrollment(period, owner), oldMine);
    assert.deepEqual(db.get('SELECT * FROM schedule_runs WHERE id=?', run), oldRun);
    assert.equal(db.get('SELECT status FROM swap_requests WHERE id=?', swapId).status, 'pending');
    assert.throws(() => submit(newcomer, [c]), /模拟统计失败/);
    assert.equal(enroll.getMyEnrollment(period, newcomer).exists, false); assert.deepEqual(active(), original);
  } finally { swaps.refreshRunMetrics = refresh; }
});

test('取消本期工作后固定规则不会重新加入本期，其他周期仍自动参与；重新报名只补近7天空位', () => {
  configs.updateWorkType(a, { weeklyAssignments: [{ weekday: 1, shiftId: am, userId: owner, dutyRole: 'primary' }] });
  submit(owner, [b]);
  assert.ok(!enroll.getEffectiveEnrollments(period).find((e) => e.userId === owner).workTypes.some((w) => w.workTypeId === a));
  const next = periods.createPeriod({ name: '下一周期', startDate: '2026-11-16', endDate: '2026-11-16', workTypeIds: [a], shiftIds: [am], initializeRequirements: true }, ctx(admin)).id;
  assert.ok(enroll.getEffectiveEnrollments(next).some((e) => e.userId === owner));
  assert.equal(submit(owner, [a, b]).scheduleChanges.addedCount, 6);
  assert.deepEqual(enroll.getMyEnrollment(period, owner).withdrawnWorkTypeIds, []);
  assert.ok(!active().some((r) => r.user_id === owner && r.work_type_id === a && r.work_date === '2026-11-11'));
});

test('只修改生效版本，不改变本周期旧版本、草稿或其他周期；现有草稿需重新检查生成', () => {
  const draft = schedule.generate(period, {}, ctx(admin));
  const oldDraft = db.all('SELECT * FROM assignments WHERE run_id=? ORDER BY id', draft.runId);
  const otherPeriod = periodRepo.insertPeriod({ name: '其他周期', startDate: '2026-11-05', endDate: '2026-11-05', status: 'published' });
  const repo = require('../src/repositories/scheduleRepo');
  const otherRun = repo.insertRun({ periodId: otherPeriod, algoVersion: 'fixture', seed: 1, status: 'published', totalNeeded: 1, totalFilled: 1, fillRate: 1, rounds: 0, durationMs: 0, createdBy: admin });
  repo.bulkInsertAssignments(otherRun, otherPeriod, [{ workDate: '2026-11-05', shiftId: am, workTypeId: a, userId: owner, dutyRole: 'primary' }]);
  submit(owner, [b]);
  assert.deepEqual(db.all('SELECT * FROM assignments WHERE run_id=? ORDER BY id', draft.runId), oldDraft);
  assert.equal(db.pluck("SELECT COUNT(*) FROM assignments WHERE run_id=? AND status='active'", otherRun), 1);
  assert.throws(() => schedule.publish(period, draft.runId, ctx(admin)), (e) => e.code === 'SCHEDULE_INPUT_CHANGED');
});

test('v7 无损迁移保留正式报名快照，支持升级后取消工作', () => {
  const original = active();
  db.exec("DROP INDEX uq_assignment_active_person_slot; CREATE UNIQUE INDEX uq_assignment_active_person_slot ON assignments(run_id,user_id,work_date,shift_id) WHERE status='active'; ALTER TABLE work_types DROP COLUMN duty_pairs_json; ALTER TABLE enrollments DROP COLUMN submitted_work_type_ids_json; ALTER TABLE enrollments DROP COLUMN withdrawn_work_type_ids_json; PRAGMA user_version=7;");
  assert.deepEqual(migrate(), { fromVersion: 7, toVersion: CURRENT_VERSION });
  assert.deepEqual(enroll.getMyEnrollment(period, owner).submittedWorkTypeIds, [a, b]);
  assert.deepEqual(active(), original);
  assert.equal(submit(owner, [b]).scheduleChanges.removedCount, 8);
});

test('主副搭档配置允许交叉组合，拒绝同人主副、重复搭配、停用人员和普通工作；配置变化使旧草稿失效', () => {
  const service = require('../src/services/configService');
  const pairs = [{ primaryUserId: owner, deputyUserId: deputy }, { primaryUserId: worker, deputyUserId: newcomer }, { primaryUserId: owner, deputyUserId: newcomer }];
  const draft = schedule.generate(period, {}, ctx(admin));
  assert.deepEqual(service.updateWorkType(a, { dutyPairs: pairs }, ctx(admin)).dutyPairs, pairs);
  assert.throws(() => schedule.publish(period, draft.runId, ctx(admin)), (e) => e.code === 'SCHEDULE_INPUT_CHANGED');
  for (const items of [[null], [{ primaryUserId: owner, deputyUserId: owner }], [pairs[0], pairs[0]], [{ primaryUserId: owner, deputyUserId: 9999 }]]) assert.throws(() => service.updateWorkType(a, { dutyPairs: items }, ctx(admin)), (e) => e.status === 400);
  assert.throws(() => service.updateWorkType(b, { dutyPairs: pairs }, ctx(admin)), (e) => e.status === 400);
  assert.throws(() => service.updateWorkType(a, { requiresRoles: false, weeklyAssignments: [] }, ctx(admin)), (e) => e.status === 400);
  assert.deepEqual(service.updateWorkType(a, { dutyPairs: [] }, ctx(admin)).dutyPairs, []);
});

test('已发布补位遵守搭档，可兼容 A主+D副；双方空位时整组补入，资格不足不排半组', () => {
  configs.updateWorkType(a, { dutyPairs: [{ primaryUserId: owner, deputyUserId: deputy }, { primaryUserId: worker, deputyUserId: newcomer }, { primaryUserId: owner, deputyUserId: newcomer }] });
  submit(owner, [b]); submit(deputy, []);
  const noPartner = submit(newcomer, [a], { workTypes: choices([a], 'deputy') });
  assert.equal(noPartner.scheduleChanges.addedCount, 0);
  const result = submit(worker, [a, c], { workTypes: choices([a, c], 'primary') });
  assert.equal(result.scheduleChanges.addedCount, 12);
  for (const date of dateRange('2026-11-05', '2026-11-10')) {
    const people = active().filter((r) => r.work_date === date && r.work_type_id === a);
    assert.equal(people.length, 2); assert.ok(people.some((r) => r.user_id === worker && r.duty_role === 'primary')); assert.ok(people.some((r) => r.user_id === newcomer && r.duty_role === 'deputy'));
  }
  assert.equal(submit(owner, [a, b]).scheduleChanges.addedCount, 0, '不替换现有搭档');
  const source = active().find((r) => r.user_id === worker && r.work_type_id === a && r.work_date === '2026-11-05');
  const problems = swaps.precheckTransfer({ period: periodRepo.findPeriod(period), assignment: source, toUserId: owner });
  assert.equal(problems.length, 0, 'A主+D副已在允许列表');
  configs.updateWorkType(a, { dutyPairs: [{ primaryUserId: worker, deputyUserId: newcomer }] });
  assert.ok(swaps.precheckTransfer({ period: periodRepo.findPeriod(period), assignment: source, toUserId: owner }).some((p) => p.code === 'DUTY_PAIR_MISMATCH'));
});

test('同班次不同工作可在已发布近7天空位补入，只计1班且数据库禁止重复同一工作', () => {
  const next = periods.createPeriod({ name: '兼任验证', startDate: '2026-11-04', endDate: '2026-11-11', workTypeIds: [a, b], shiftIds: [am], maxShiftsPerDay: 1, maxShiftsPerWeek: 7, forbidConsecutive: true, initializeRequirements: true }, ctx(admin)).id;
  enroll.saveAdminEnrollment(next, owner, { workTypes: choices([a]) }, ctx(admin));
  enroll.saveAdminEnrollment(next, deputy, { workTypes: choices([a], 'deputy') }, ctx(admin));
  const draft = schedule.generate(next, {}, ctx(admin)); schedule.publish(next, draft.runId, ctx(admin));
  const original = db.all("SELECT * FROM assignments WHERE run_id=? AND status='active' ORDER BY id", draft.runId);
  const result = enroll.saveEnrollment(next, owner, { workTypes: choices([a, b]), maxShifts: 8, submit: true }, ctx());
  assert.equal(result.scheduleChanges.addedCount, 7);
  assert.deepEqual(db.all("SELECT * FROM assignments WHERE run_id=? AND id<=? ORDER BY id", draft.runId, original.at(-1).id), original);
  const view = schedule.getSchedule(next, ctx(admin).user, { version: 'published' });
  assert.equal(view.gaps.byEmployee.find((e) => e.userId === owner).assigned, 8);
  assert.equal(view.metrics.workload.distribution.find((e) => e.userId === owner).assigned, 8);
  assert.equal(require('../src/services/statsService').getPeriodStats(next).metrics.workload.distribution.find((e) => e.userId === owner).assigned, 8);
  assert.equal(enroll.saveEnrollment(next, owner, { workTypes: choices([a, b]), maxShifts: 8, submit: true }, ctx()).scheduleChanges.addedCount, 0);
  assert.throws(() => require('../src/repositories/scheduleRepo').bulkInsertAssignments(draft.runId, next, [{ workDate: '2026-11-04', shiftId: am, workTypeId: a, userId: owner, dutyRole: 'deputy' }]), /UNIQUE constraint/);
});
