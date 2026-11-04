'use strict';

/**
 * 「当前周期」判定测试
 *
 * 曾经踩过的坑：按 status 挑 published，会命中更早的历史已发布周期，
 * 导致员工打开首页看到上一周排班、报名入口指向已结束的周期。
 * 正确口径是「日期范围覆盖今天」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-period-'));
process.env.DB_FILE = path.join(tmpDir, 'test.db');

const db = require('../src/db/db');
const { migrate } = require('../src/db/migrate');
const periodRepo = require('../src/repositories/periodRepo');
const periodService = require('../src/services/periodService');
const { nowIso, today, addDays } = require('../src/utils/date');

function insertPeriod(name, startDate, endDate, status) {
  const now = nowIso();
  db.run(
    `INSERT INTO periods (name,start_date,end_date,max_shifts_per_day,max_shifts_per_week,
                          forbid_consecutive,status,created_at,updated_at)
     VALUES (?,?,?,1,5,1,?,?,?)`,
    name,
    startDate,
    endDate,
    status,
    now,
    now
  );
  return db.pluck('SELECT id FROM periods WHERE name = ?', name);
}

test.before(() => {
  migrate();
  db.run('DELETE FROM periods');
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('历史周期与本周周期同时是 published 时，应选中覆盖今天的那周', () => {
  const t = today();
  const histId = insertPeriod('历史周期', addDays(t, -21), addDays(t, -15), 'published');
  const curId = insertPeriod('本周周期', addDays(t, -2), addDays(t, 4), 'published');

  const found = periodRepo.findCurrentPeriod();
  assert.equal(found.id, curId, '必须选中覆盖今天的周期，而不是更早的历史周期');
  assert.notEqual(found.id, histId);
});

test('本周还在报名（enrolling）时，也要能选中它', () => {
  db.run('DELETE FROM periods');
  const t = today();
  insertPeriod('已结束周期', addDays(t, -21), addDays(t, -15), 'published');
  const enrollingId = insertPeriod('本周报名中', addDays(t, -1), addDays(t, 5), 'enrolling');

  const found = periodRepo.findCurrentPeriod();
  assert.equal(found.id, enrollingId);
});

test('没有任何周期覆盖今天时，选最近一个即将开始的', () => {
  db.run('DELETE FROM periods');
  const t = today();
  insertPeriod('已结束周期', addDays(t, -21), addDays(t, -15), 'published');
  const futureId = insertPeriod('下周期', addDays(t, 3), addDays(t, 9), 'enrolling');

  const found = periodRepo.findCurrentPeriod();
  assert.equal(found.id, futureId, '应选最近未开始的周期');
});

test('已归档周期不参与当前周期候选', () => {
  db.run('DELETE FROM periods');
  const t = today();
  insertPeriod('归档周期', addDays(t, -2), addDays(t, 4), 'archived');
  const normalId = insertPeriod('正常周期', addDays(t, 4), addDays(t, 10), 'draft');

  const found = periodRepo.findCurrentPeriod();
  assert.equal(found.id, normalId, '归档周期应被跳过');
});

test('全部过期时兜底返回最近结束的周期，而不是 null', () => {
  db.run('DELETE FROM periods');
  const t = today();
  const olderId = insertPeriod('更早', addDays(t, -30), addDays(t, -24), 'published');
  const recentId = insertPeriod('最近', addDays(t, -10), addDays(t, -4), 'published');

  const found = periodRepo.findCurrentPeriod();
  assert.equal(found.id, recentId);
  assert.notEqual(found.id, olderId);
});

test('服务层 findCurrentPeriod 与仓储层口径一致', () => {
  db.run('DELETE FROM periods');
  const t = today();
  insertPeriod('历史', addDays(t, -21), addDays(t, -15), 'published');
  const curId = insertPeriod('本周', addDays(t, -1), addDays(t, 5), 'published');

  const fromRepo = periodRepo.findCurrentPeriod();
  const fromService = periodService.findCurrentPeriod(periodService.listPeriods());

  assert.equal(fromRepo.id, curId);
  assert.equal(fromService.id, curId, '两处口径必须一致，否则总览和首页会显示不同周期');
});
