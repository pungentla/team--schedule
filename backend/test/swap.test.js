'use strict';

/**
 * 换班状态机单元测试
 * 用独立的临时数据库，不污染开发数据。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-test-'));
process.env.DB_FILE = path.join(tmpDir, 'test.db');

const db = require('../src/db/db');
const { migrate } = require('../src/db/migrate');
const swapService = require('../src/services/swapService');
const scheduleRepo = require('../src/repositories/scheduleRepo');
const { hashPasswordSync } = require('../src/utils/security');
const { nowIso } = require('../src/utils/date');

let ids = {};

/** 建立一个最小可用场景：1 周期、3 员工、1 工作类型、1 班次、1 天 */
function setup() {
  migrate();

  const now = nowIso();
  // 班次
  db.run(
    `INSERT INTO shifts (code,name,start_time,end_time,seq,color,active,created_at,updated_at)
     VALUES ('S1','早班','08:00','14:00',1,'#000',1,?,?)`, now, now);
  const shiftId = db.pluck(`SELECT id FROM shifts WHERE code='S1'`);

  // 工作类型 2 个，便于做 exchange
  db.run(`INSERT INTO work_types (code,name,color,sort_order,active,created_at,updated_at)
          VALUES ('W1','工作一','#111',1,1,?,?)`, now, now);
  db.run(`INSERT INTO work_types (code,name,color,sort_order,active,created_at,updated_at)
          VALUES ('W2','工作二','#222',2,1,?,?)`, now, now);
  const w1 = db.pluck(`SELECT id FROM work_types WHERE code='W1'`);
  const w2 = db.pluck(`SELECT id FROM work_types WHERE code='W2'`);

  // 用户
  const pwd = hashPasswordSync('123456');
  db.run(`INSERT INTO users (employee_no,name,password_hash,role,status,created_at,updated_at)
          VALUES ('admin','管理员',?,'admin','active',?,?)`, pwd, now, now);
  for (const no of ['u1', 'u2', 'u3']) {
    db.run(`INSERT INTO users (employee_no,name,password_hash,role,status,created_at,updated_at)
            VALUES (?,?,?,'employee','active',?,?)`, no, `员工${no}`, pwd, now, now);
  }
  const adminId = db.pluck(`SELECT id FROM users WHERE employee_no='admin'`);
  const u1 = db.pluck(`SELECT id FROM users WHERE employee_no='u1'`);
  const u2 = db.pluck(`SELECT id FROM users WHERE employee_no='u2'`);
  const u3 = db.pluck(`SELECT id FROM users WHERE employee_no='u3'`);

  // 周期（已发布，宽松约束便于测试状态机本身）
  db.run(`INSERT INTO periods (name,start_date,end_date,max_shifts_per_day,max_shifts_per_week,
          forbid_consecutive,status,created_at,updated_at)
          VALUES ('P','2025-06-02','2025-06-08',1,7,0,'published',?,?)`, now, now);
  const periodId = db.pluck(`SELECT id FROM periods ORDER BY id DESC LIMIT 1`);

  // 两个日期格子
  for (const d of ['2025-06-02', '2025-06-03']) {
    db.run(`INSERT INTO period_slots (period_id,work_date,shift_id) VALUES (?,?,?)`, periodId, d, shiftId);
  }

  // 报名：u1/u2/u3 都报 W1；u1/u2 也报 W2
  const enroll = (uid, wts) => {
    db.run(`INSERT INTO enrollments (period_id,user_id,max_shifts,status,submitted_at,created_at,updated_at)
            VALUES (?,?,10,'submitted',?,?,?)`, periodId, uid, now, now, now);
    const eid = db.pluck('SELECT id FROM enrollments WHERE period_id=? AND user_id=?', periodId, uid);
    for (const w of wts) {
      db.run(`INSERT INTO enrollment_work_types (enrollment_id,work_type_id,priority) VALUES (?,?,1)`, eid, w);
    }
  };
  enroll(u1, [w1, w2]);
  enroll(u2, [w1, w2]);
  enroll(u3, [w1]);

  // 排班 run + 分配：u1 在 06-02 早班做 W1；u2 在 06-03 早班做 W1；u3 在 06-03 早班做 W2
  db.run(`INSERT INTO schedule_runs (period_id,algo_version,seed,status,total_needed,total_filled,fill_rate,created_by,created_at)
          VALUES (?,'t',1,'published',3,3,1.0,?,?)`, periodId, adminId, now);
  const runId = db.pluck('SELECT id FROM schedule_runs WHERE period_id=?', periodId);

  const mkAssign = (date, wtId, uid) => {
    scheduleRepo.insertSwapAssignment({
      runId, periodId, workDate: date, shiftId, workTypeId: wtId, userId: uid,
    });
  };
  mkAssign('2025-06-02', w1, u1);
  mkAssign('2025-06-03', w1, u2);
  mkAssign('2025-06-03', w2, u3);

  ids = { periodId, runId, shiftId, w1, w2, adminId, u1, u2, u3 };
  return ids;
}

function ctxFor(userId) {
  const u = db.get('SELECT id, role, employee_no, name FROM users WHERE id = ?', userId);
  return { user: { id: u.id, role: u.role, employeeNo: u.employee_no, name: u.name }, requestId: 'test' };
}

function cleanDb() {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['swap_participants', 'swap_requests', 'assignments', 'schedule_runs', 'slot_requirements',
    'period_slots', 'periods', 'availability_slots', 'unavailability_dates', 'enrollment_work_types',
    'enrollments', 'audit_logs', 'sessions', 'push_events', 'push_subscriptions', 'users', 'work_types', 'shifts', 'invites']) {
    db.run(`DELETE FROM ${t}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
}

test.beforeEach(() => {
  migrate();   // 首次运行建表；后续幂等
  cleanDb();
  setup();
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test('transfer: 发起 → 接收人同意 → 自动生效', () => {
  const { u1, u2, w1 } = ids;
  for (const userId of [u1, u2]) {
    db.run('INSERT INTO push_subscriptions (endpoint,user_id,p256dh,auth) VALUES (?,?,?,?)', `https://web.push.apple.com/${userId}`, userId, 'fixture', 'fixture');
  }
  const assignment = db.get(
    `SELECT id FROM assignments WHERE user_id=? AND work_type_id=? AND status='active'`, u1, w1
  );

  const created = swapService.createSwap(
    { type: 'transfer', fromAssignmentId: assignment.id, toUserId: u2 },
    ctxFor(u1)
  );
  assert.equal(created.swap.status, 'pending');
  assert.equal(created.participants.length, 2);
  // 发起人已自动 approved，接收人 pending
  const req = created.participants.find((p) => p.role === 'requester');
  const rec = created.participants.find((p) => p.role === 'receiver');
  assert.equal(req.status, 'approved');
  assert.equal(rec.status, 'pending');
  assert.deepEqual(db.all('SELECT user_id FROM push_events ORDER BY id').map(row => row.user_id), [u2]);

  const result = swapService.confirm(created.swap.id, ctxFor(u2));
  assert.equal(result.applied, true);
  assert.equal(result.status, 'approved');
  assert.deepEqual(db.all('SELECT user_id FROM push_events ORDER BY id').map(row => row.user_id), [u2, u1]);

  // 原分配已释放，新分配属于 u2
  const old = db.get('SELECT * FROM assignments WHERE id = ?', assignment.id);
  assert.equal(old.status, 'released');
  const now = db.get(
    `SELECT * FROM assignments WHERE work_date=? AND shift_id=? AND work_type_id=? AND status='active'`,
    old.work_date, old.shift_id, w1
  );
  assert.equal(now.user_id, u2);
  assert.equal(now.source, 'swap');
});

test('transfer 返回 waitingFor（未全员同意不生效）', () => {
  const { u1, u2, u3, w1 } = ids;
  const assignment = db.get(`SELECT id FROM assignments WHERE user_id=? AND status='active'`, u1);
  const created = swapService.createSwap(
    { type: 'transfer', fromAssignmentId: assignment.id, toUserId: u2 },
    ctxFor(u1)
  );
  // 让 u3 也成为参与者，模拟未来多方确认
  db.run(`INSERT INTO swap_participants (swap_id,user_id,role,seq,status) VALUES (?,?,'receiver',2,'pending')`,
    created.swap.id, u3);

  const r = swapService.confirm(created.swap.id, ctxFor(u2));
  assert.equal(r.applied, false);
  assert.equal(r.status, 'pending');
  assert.equal(r.waitingFor.length, 1);
  assert.equal(r.waitingFor[0].userId, u3);

  // 原分配仍未变
  const old = db.get('SELECT status,user_id FROM assignments WHERE id=?', assignment.id);
  assert.equal(old.status, 'active');
  assert.equal(old.user_id, u1);
});

test('exchange: 双方互换班次', () => {
  const { u1, u2, w1 } = ids;
  const a1 = db.get(`SELECT * FROM assignments WHERE user_id=? AND work_date='2025-06-02'`, u1);
  const b1 = db.get(`SELECT * FROM assignments WHERE user_id=? AND work_date='2025-06-03' AND work_type_id=?`, u2, w1);

  const created = swapService.createSwap(
    { type: 'exchange', fromAssignmentId: a1.id, toUserId: u2, toAssignmentId: b1.id },
    ctxFor(u1)
  );
  assert.equal(created.swap.type, 'exchange');

  const r = swapService.confirm(created.swap.id, ctxFor(u2));
  assert.equal(r.applied, true);

  // u1 现在持有 06-03 的 W1；u2 持有 06-02 的 W1
  const nowA = db.get(`SELECT user_id FROM assignments WHERE work_date='2025-06-02' AND work_type_id=? AND status='active'`, w1);
  const nowB = db.get(`SELECT user_id FROM assignments WHERE work_date='2025-06-03' AND work_type_id=? AND status='active'`, w1);
  assert.equal(nowA.user_id, u2, '06-02 应换成 u2');
  assert.equal(nowB.user_id, u1, '06-03 应换成 u1');
});

test('exchange: 个人班次已达上限时，详情应按互换后的状态允许确认', () => {
  const { u1, u2, periodId } = ids;
  db.run('UPDATE enrollments SET max_shifts=1 WHERE period_id=?', periodId);
  const from = db.get("SELECT id FROM assignments WHERE user_id=? AND status='active'", u1);
  const target = db.get("SELECT id FROM assignments WHERE user_id=? AND status='active'", u2);
  const created = swapService.createSwap({ type: 'exchange', fromAssignmentId: from.id, toUserId: u2, toAssignmentId: target.id }, ctxFor(u1));
  const detail = swapService.getSwapDetail(created.swap.id, ctxFor(u2).user);
  assert.equal(detail.canConfirm, true);
  assert.deepEqual(detail.liveProblems, []);
  assert.equal(swapService.confirm(created.swap.id, ctxFor(u2)).applied, true);
});

test('主负责人不能转给只报名副的人，合格接班后原岗位角色保持不变', () => {
  const { u1, u2, u3 } = ids;
  const from = db.get("SELECT * FROM assignments WHERE user_id=? AND status='active'", u1);
  db.run("UPDATE assignments SET duty_role='primary' WHERE id=?", from.id);
  db.run("UPDATE enrollment_work_types SET duty_role='deputy' WHERE enrollment_id IN (SELECT id FROM enrollments WHERE user_id=?)", u2);
  db.run("UPDATE enrollment_work_types SET duty_role='both' WHERE enrollment_id IN (SELECT id FROM enrollments WHERE user_id=?)", u3);
  assert.throws(() => swapService.createSwap({ type: 'transfer', fromAssignmentId: from.id, toUserId: u2 }, ctxFor(u1)), (e) => e.details.problems.some((p) => p.code === 'role_mismatch'));
  const created = swapService.createSwap({ type: 'transfer', fromAssignmentId: from.id, toUserId: u3 }, ctxFor(u1));
  swapService.confirm(created.swap.id, ctxFor(u3));
  const received = db.get("SELECT * FROM assignments WHERE user_id=? AND work_date=? AND shift_id=? AND status='active'", u3, from.work_date, from.shift_id);
  assert.equal(received.duty_role, 'primary');
});

test('确认前接收人角色变化会阻止生效，并保持原班次和待确认状态', () => {
  const { u1, u3 } = ids;
  const from = db.get("SELECT * FROM assignments WHERE user_id=? AND status='active'", u1);
  db.run("UPDATE assignments SET duty_role='primary' WHERE id=?", from.id);
  db.run("UPDATE enrollment_work_types SET duty_role='both' WHERE enrollment_id IN (SELECT id FROM enrollments WHERE user_id=?)", u3);
  const created = swapService.createSwap({ type: 'transfer', fromAssignmentId: from.id, toUserId: u3 }, ctxFor(u1));
  db.run("UPDATE enrollment_work_types SET duty_role='deputy' WHERE enrollment_id IN (SELECT id FROM enrollments WHERE user_id=?)", u3);
  assert.equal(swapService.getSwapDetail(created.swap.id, ctxFor(u3).user).canConfirm, false);
  assert.throws(() => swapService.confirm(created.swap.id, ctxFor(u3)), (e) => e.code === 'SWAP_CONFLICT');
  assert.equal(db.get('SELECT status FROM assignments WHERE id=?', from.id).status, 'active');
  assert.equal(swapService.getSwapDetail(created.swap.id, ctxFor(u3).user).myDecision, 'pending');
});

test('发布版本被替换后，旧版本的换班不能再确认生效', () => {
  const { u1, u2, runId } = ids;
  const from = db.get("SELECT * FROM assignments WHERE user_id=? AND status='active'", u1);
  const created = swapService.createSwap({ type: 'transfer', fromAssignmentId: from.id, toUserId: u2 }, ctxFor(u1));
  db.run("UPDATE schedule_runs SET status='discarded' WHERE id=?", runId);
  const detail = swapService.getSwapDetail(created.swap.id, ctxFor(u2).user);
  assert.equal(detail.canConfirm, false);
  assert.equal(detail.liveProblems[0].code, 'schedule_replaced');
  assert.throws(() => swapService.confirm(created.swap.id, ctxFor(u2)), (e) => e.code === 'SWAP_CONFLICT');
  assert.equal(db.get('SELECT status FROM assignments WHERE id=?', from.id).status, 'active');
});

test('rejected: 任一方拒绝则不生效', () => {
  const { u1, u2 } = ids;
  const assignment = db.get(`SELECT id FROM assignments WHERE user_id=? AND status='active'`, u1);
  const created = swapService.createSwap(
    { type: 'transfer', fromAssignmentId: assignment.id, toUserId: u2 },
    ctxFor(u1)
  );

  swapService.reject(created.swap.id, '不想接', ctxFor(u2));

  const sw = db.get('SELECT status FROM swap_requests WHERE id=?', created.swap.id);
  assert.equal(sw.status, 'rejected');

  // 原分配仍属于 u1
  const old = db.get('SELECT status,user_id FROM assignments WHERE id=?', assignment.id);
  assert.equal(old.status, 'active');
  assert.equal(old.user_id, u1);
});

test('cancelled: 发起人可撤回', () => {
  const { u1, u2 } = ids;
  const assignment = db.get(`SELECT id FROM assignments WHERE user_id=? AND status='active'`, u1);
  const created = swapService.createSwap(
    { type: 'transfer', fromAssignmentId: assignment.id, toUserId: u2 },
    ctxFor(u1)
  );

  swapService.cancel(created.swap.id, ctxFor(u1));
  assert.equal(db.get('SELECT status FROM swap_requests WHERE id=?', created.swap.id).status, 'cancelled');

  // 撤回后不能确认
  assert.throws(() => swapService.confirm(created.swap.id, ctxFor(u2)), /已结束/);
});

test('幂等: 重复确认返回 ALREADY_DECIDED', () => {
  const { u1, u2 } = ids;
  const assignment = db.get(`SELECT id FROM assignments WHERE user_id=? AND status='active'`, u1);
  const created = swapService.createSwap(
    { type: 'transfer', fromAssignmentId: assignment.id, toUserId: u2 },
    ctxFor(u1)
  );

  swapService.confirm(created.swap.id, ctxFor(u2));
  try {
    swapService.confirm(created.swap.id, ctxFor(u2));
    assert.fail('应该抛错');
  } catch (err) {
    assert.equal(err.code, 'ALREADY_DECIDED');
  }
  // 只产生一条新分配
  const count = db.pluck(
    `SELECT COUNT(*) FROM assignments WHERE work_date='2025-06-02' AND work_type_id=? AND status='active'`, ids.w1
  );
  assert.equal(count, 1);
});

test('越权: 非参与者不能确认', () => {
  const { u1, u2, u3 } = ids;
  const assignment = db.get(`SELECT id FROM assignments WHERE user_id=? AND status='active'`, u1);
  const created = swapService.createSwap(
    { type: 'transfer', fromAssignmentId: assignment.id, toUserId: u2 },
    ctxFor(u1)
  );

  try {
    swapService.confirm(created.swap.id, ctxFor(u3));
    assert.fail('应该抛错');
  } catch (err) {
    assert.equal(err.code, 'FORBIDDEN');
  }
});

test('约束: 接收人未报名该工作类型 → 创建时就拒绝', () => {
  const { u1, u2, w2 } = ids;
  // setup 中 u1 持有 06-02 的 W1；此处新增一条 u1 在 06-03 的 W2 班次作为待转出对象
  // （不能放 06-02：同一人同一天同一班次只能有一个岗位）
  db.run(
    `INSERT INTO period_slots (period_id,work_date,shift_id) VALUES (?,?,?)`,
    ids.periodId, '2025-06-04', ids.shiftId
  );
  const u1W2 = scheduleRepo.insertSwapAssignment({
    runId: ids.runId,
    periodId: ids.periodId,
    workDate: '2025-06-04',
    shiftId: ids.shiftId,
    workTypeId: w2,
    userId: u1,
  });

  // 让 u2 退出 W2 的报名，模拟"未报名该工作"的接收人
  const e2 = db.get('SELECT id FROM enrollments WHERE period_id=? AND user_id=?', ids.periodId, u2);
  db.run('DELETE FROM enrollment_work_types WHERE enrollment_id=? AND work_type_id=?', e2.id, w2);

  try {
    swapService.createSwap(
      { type: 'transfer', fromAssignmentId: u1W2, toUserId: u2 },
      ctxFor(u1)
    );
    assert.fail('应因未报名而拒绝');
  } catch (err) {
    assert.equal(err.code, 'SWAP_CONSTRAINT_VIOLATION');
    assert.equal(err.details.problems[0].code, 'not_enrolled');
  }
});

test('冲突回滚: 生效时约束失败 → 整体回滚且参与人可重试', () => {
  const { u1, u2, w1 } = ids;
  const assignment = db.get(`SELECT * FROM assignments WHERE user_id=? AND status='active'`, u1);
  const created = swapService.createSwap(
    { type: 'transfer', fromAssignmentId: assignment.id, toUserId: u2 },
    ctxFor(u1)
  );

  // 模拟"申请期间 u2 被手动排到同一班次"
  db.run(
    `INSERT INTO assignments (run_id,period_id,work_date,shift_id,work_type_id,user_id,status,source,created_at)
     VALUES (?,?,?,?,?,?, 'active','manual',?)`,
    ids.runId, ids.periodId, assignment.work_date, assignment.shift_id, w1, u2, nowIso()
  );

  try {
    swapService.confirm(created.swap.id, ctxFor(u2));
    assert.fail('应抛冲突错误');
  } catch (err) {
    assert.equal(err.code, 'SWAP_CONFLICT');
  }

  // 事务完整回滚：swap 仍 pending，原分配未释放
  assert.equal(db.get('SELECT status FROM swap_requests WHERE id=?', created.swap.id).status, 'pending');
  const old = db.get('SELECT status,user_id FROM assignments WHERE id=?', assignment.id);
  assert.equal(old.status, 'active');
  assert.equal(old.user_id, u1);

  // 接收人 participant 退回 pending，允许重试
  const rec = db.get(
    `SELECT status FROM swap_participants WHERE swap_id=? AND user_id=?`, created.swap.id, u2
  );
  assert.equal(rec.status, 'pending', '失败后必须可重试');

  // 移除冲突后重试应成功
  db.run(
    `DELETE FROM assignments WHERE work_date=? AND shift_id=? AND work_type_id=? AND user_id=? AND source='manual'`,
    assignment.work_date, assignment.shift_id, w1, u2
  );
  const r2 = swapService.confirm(created.swap.id, ctxFor(u2));
  assert.equal(r2.applied, true);
});

test('审计日志: 记录创建/确认/生效', () => {
  const { u1, u2 } = ids;
  const assignment = db.get(`SELECT id FROM assignments WHERE user_id=? AND status='active'`, u1);
  const created = swapService.createSwap(
    { type: 'transfer', fromAssignmentId: assignment.id, toUserId: u2 },
    ctxFor(u1)
  );
  swapService.confirm(created.swap.id, ctxFor(u2));

  const actions = db.all('SELECT action FROM audit_logs ORDER BY id').map((r) => r.action);
  assert.ok(actions.includes('SWAP_CREATE'), '应有 SWAP_CREATE');
  assert.ok(actions.includes('SWAP_CONFIRM'), '应有 SWAP_CONFIRM');
  assert.ok(actions.includes('SWAP_APPLY'), '应有 SWAP_APPLY');
});

test('历史统计: 换班后原班次不计入轮转历史', () => {
  const { u1, u2, periodId } = ids;
  const assignment = db.get(`SELECT id FROM assignments WHERE user_id=? AND status='active'`, u1);
  const created = swapService.createSwap(
    { type: 'transfer', fromAssignmentId: assignment.id, toUserId: u2 },
    ctxFor(u1)
  );
  swapService.confirm(created.swap.id, ctxFor(u2));

  // 统计仅 active：u1 在该工作上的计数应减少
  const u1Active = db.pluck(
    `SELECT COUNT(*) FROM assignments a JOIN schedule_runs r ON r.id=a.run_id AND r.status='published'
      WHERE a.user_id=? AND a.status='active'`, u1
  );
  const u2Active = db.pluck(
    `SELECT COUNT(*) FROM assignments a JOIN schedule_runs r ON r.id=a.run_id AND r.status='published'
      WHERE a.user_id=? AND a.status='active'`, u2
  );
  assert.equal(u1Active, 0, 'u1 已无 active 排班');
  assert.equal(u2Active, 2, 'u2 继承了该班次');
});
