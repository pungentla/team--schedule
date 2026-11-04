'use strict';

/**
 * 排班表读取视角测试
 *
 * 核心规则：
 *   管理员生成草稿后必须能立刻看到新草稿（否则无法预览、无法决定是否发布）
 *   员工只能看到已发布版本（草稿未生效，展示给员工会造成误导）
 *
 * 用独立临时数据库，不污染开发数据。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-runtest-'));
process.env.DB_FILE = path.join(tmpDir, 'test.db');

const db = require('../src/db/db');
const { migrate } = require('../src/db/migrate');
const scheduleRepo = require('../src/repositories/scheduleRepo');
const periodRepo = require('../src/repositories/periodRepo');
const scheduleService = require('../src/services/scheduleService');
const { nowIso } = require('../src/utils/date');
const { hashPasswordSync } = require('../src/utils/security');

let ADMIN = { role: 'admin', name: '管理员' };
let EMPLOYEE = { role: 'employee', name: '员工' };

let periodId;

function setup() {
  migrate();
  const now = nowIso();

  db.run(
    `INSERT INTO shifts (code,name,start_time,end_time,seq,color,active,created_at,updated_at)
     VALUES ('S1','早班','08:00','14:00',1,'#000',1,?,?)`,
    now,
    now
  );
  db.run(
    `INSERT INTO work_types (code,name,color,sort_order,active,created_at,updated_at)
     VALUES ('W1','工作一','#111',1,1,?,?)`,
    now,
    now
  );
  db.run(
    `INSERT INTO periods (name,start_date,end_date,max_shifts_per_day,max_shifts_per_week,
                         forbid_consecutive,status,created_at,updated_at)
     VALUES ('测试周期','2026-01-05','2026-01-11',1,5,1,'published',?,?)`,
    now,
    now
  );
  periodId = db.pluck('SELECT id FROM periods ORDER BY id DESC LIMIT 1');

  // schedule_runs.created_by 与 assignments.user_id 都有外键，需真实用户
  const pwd = hashPasswordSync('123456');
  db.run(
    `INSERT INTO users (employee_no,name,password_hash,role,status,created_at,updated_at)
     VALUES ('admin','管理员',?,'admin','active',?,?)`,
    pwd, now, now
  );
  db.run(
    `INSERT INTO users (employee_no,name,password_hash,role,status,created_at,updated_at)
     VALUES ('emp001','员工甲',?,'employee','active',?,?)`,
    pwd, now, now
  );
  ADMIN = { ...ADMIN, id: db.pluck(`SELECT id FROM users WHERE employee_no='admin'`) };
  EMPLOYEE = { ...EMPLOYEE, id: db.pluck(`SELECT id FROM users WHERE employee_no='emp001'`) };
}

/** 直接插一条 run + 一条分配，避免依赖完整排班输入 */
function insertRun(status, seed, userId = EMPLOYEE.id) {
  const now = nowIso();
  const runId = scheduleRepo.insertRun({
    periodId,
    algoVersion: 'test',
    seed,
    inputHash: `hash-${seed}`,
    status,
    totalNeeded: 1,
    totalFilled: 1,
    fillRate: 1,
    metricsJson: JSON.stringify({ perWorkType: [], workload: {}, fairnessScore: 1, grade: 'excellent' }),
    gapsJson: JSON.stringify({ totalNeeded: 1, totalFilled: 1, totalGap: 0, fillRate: 1 }),
    rounds: 1,
    durationMs: 1,
    createdBy: ADMIN.id,
  });
  const shiftId = db.pluck(`SELECT id FROM shifts WHERE code='S1'`);
  const workTypeId = db.pluck(`SELECT id FROM work_types WHERE code='W1'`);
  db.run(
    `INSERT INTO assignments (run_id,period_id,work_date,shift_id,work_type_id,user_id,status,source,created_at)
     VALUES (?,?,'2026-01-05',?,?,?,'active','algo',?)`,
    runId,
    periodId,
    shiftId,
    workTypeId,
    userId,
    now
  );
  return runId;
}

function clean() {
  db.run('DELETE FROM assignments');
  db.run('DELETE FROM schedule_runs');
}

test.beforeEach(() => {
  if (!periodId) setup();
  clean();
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('管理员在只有已发布版本时看到已发布版本', () => {
  const publishedId = insertRun('published', 42);
  const data = scheduleService.getSchedule(periodId, ADMIN);
  assert.equal(data.run.id, publishedId);
  assert.equal(data.run.status, 'published');
});

test('管理员生成草稿后应立刻看到草稿，而不是旧的已发布版本', () => {
  insertRun('published', 42);
  const draftId = insertRun('draft', 5754);

  const data = scheduleService.getSchedule(periodId, ADMIN);
  assert.equal(data.run.id, draftId, '管理员必须看到最新草稿');
  assert.equal(data.run.status, 'draft');
  assert.equal(data.run.seed, 5754);
});

test('员工只能看到已发布版本，草稿不可见', () => {
  const publishedId = insertRun('published', 42);
  insertRun('draft', 5754);

  const data = scheduleService.getSchedule(periodId, EMPLOYEE);
  assert.equal(data.run.id, publishedId, '员工不能看到草稿');
  assert.equal(data.run.status, 'published');
});

test('员工在只有草稿时看不到任何排班', () => {
  insertRun('draft', 5754);

  const data = scheduleService.getSchedule(periodId, EMPLOYEE);
  assert.equal(data.run, null);
  assert.equal(data.matrix.length, 0);
  assert.match(data.message, /还没有生成排班/);
});

test('指定 runId 时按指定版本返回（管理员预览历史草稿）', () => {
  const publishedId = insertRun('published', 42);
  const draftId = insertRun('draft', 5754);

  const data = scheduleService.getSchedule(periodId, ADMIN, { runId: publishedId });
  assert.equal(data.run.id, publishedId, '显式 runId 优先于默认策略');
  assert.notEqual(data.run.id, draftId);
});

test('发布草稿后管理员与员工看到同一个版本', () => {
  const draftId = insertRun('draft', 5754);
  scheduleService.publish(periodId, draftId, { user: ADMIN, requestId: 'req-test' });

  const adminView = scheduleService.getSchedule(periodId, ADMIN);
  const empView = scheduleService.getSchedule(periodId, EMPLOYEE);

  assert.equal(adminView.run.id, draftId);
  assert.equal(empView.run.id, draftId);
  assert.equal(adminView.run.status, 'published');
  assert.equal(empView.run.status, 'published');
});
