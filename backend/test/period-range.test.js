'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-range-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
const { periodEndDate, diffDays } = require('../src/utils/date');
const periods = require('../src/services/periodService');
const db = require('../src/db/db');
const { migrate } = require('../src/db/migrate');

test('一周、月、双月、季度、半年和一年按起始日期计算含首尾范围', () => {
  const expected = { week: '2026-11-10', month: '2026-12-03', bimonth: '2027-01-03', quarter: '2027-02-03', halfyear: '2027-05-03', year: '2027-11-03' };
  for (const [duration, end] of Object.entries(expected)) assert.equal(periodEndDate('2026-11-04', duration), end);
  assert.equal(periodEndDate('2026-01-31', 'month'), '2026-02-28');
  assert.equal(periodEndDate('2024-02-01', 'month'), '2024-02-29');
  assert.equal(periodEndDate('2024-02-29', 'year'), '2025-02-28');
  assert.equal(diffDays('2024-02-29', periodEndDate('2024-02-29', 'year')) + 1, 366);
  assert.throws(() => periodEndDate('2026-02-30', 'week'), /无效/);
});

test('后端创建和修改都接受一年，拒绝倒序和超过一年', () => {
  migrate();
  db.run("INSERT INTO users (employee_no,name,password_hash,role,status,created_at,updated_at) VALUES ('a','管理员','fixture','admin','active','now','now')");
  const ctx = { user: { id: 1 }, requestId: 'range-test' };
  const p = periods.createPeriod({ name: '年度', startDate: '2024-01-01', endDate: '2024-12-31' }, ctx);
  assert.equal(p.endDate, '2024-12-31');
  assert.throws(() => periods.createPeriod({ name: '超长', startDate: '2024-01-01', endDate: '2025-01-01' }, ctx), /最长一年/);
  assert.throws(() => periods.updatePeriod(p.id, { endDate: '2025-01-01' }, ctx), /最长一年/);
  assert.throws(() => periods.updatePeriod(p.id, { endDate: '2023-12-31' }, ctx), /不能早于/);
});
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
