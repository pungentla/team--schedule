'use strict';

/**
 * 种子数据 —— 幂等（可重复执行），--reset 先清空。
 *
 * 内容：
 *   - 管理员 1 名：admin / 123456
 *   - 员工 20 名：emp001 ~ emp020 / 123456
 *   - 工作类型 5 种：前台接待、后厨帮工、清洁消杀、物资整理、活动支援
 *   - 班次 3 个：早班(08:00-14:00) / 中班(14:00-20:00) / 晚班(20:00-23:00)
 *   - 历史周期 1 个（已发布，用于轮转历史统计）
 *   - 当前周期 1 个（7 天，已开放报名，含需求配置 + 全部员工报名）
 */

const crypto = require('node:crypto');
const db = require('../src/db/db');
const { migrate, truncateAll } = require('../src/db/migrate');
const { hashPasswordSync } = require('../src/utils/security');
const { today, addDays, dateRange, nowIso } = require('../src/utils/date');

const PASSWORD = '123456';

const WORK_TYPES = [
  { code: 'FRONT', name: '前台接待', color: '#4A90D9', sortOrder: 1, description: '接待访客、登记、电话接听' },
  { code: 'KITCHEN', name: '后厨帮工', color: '#E8834A', sortOrder: 2, description: '备餐、打饭、厨房清理' },
  { code: 'CLEAN', name: '清洁消杀', color: '#3FAE7E', sortOrder: 3, description: '公共区域清洁与消毒' },
  { code: 'SUPPLY', name: '物资整理', color: '#9B6BC4', sortOrder: 4, description: '物资清点、入库、发放' },
  { code: 'EVENT', name: '活动支援', color: '#D9536F', sortOrder: 5, description: '活动现场布置与秩序维护' },
];

const SHIFTS = [
  { code: 'MORNING', name: '早班', startTime: '08:00', endTime: '14:00', seq: 1, color: '#F0B429' },
  { code: 'AFTERNOON', name: '中班', startTime: '14:00', endTime: '20:00', seq: 2, color: '#4A90D9' },
  { code: 'NIGHT', name: '晚班', startTime: '20:00', endTime: '23:00', seq: 3, color: '#6B5B95' },
];

const EMPLOYEES = [
  '张伟', '王芳', '李娜', '刘洋', '陈静', '杨帆', '赵敏', '黄磊', '周涛', '吴倩',
  '徐明', '孙丽', '马超', '朱琳', '胡军', '郭婷', '林峰', '何雯', '高翔', '罗娟',
];

/** 确定性伪随机，保证每次 seed 结果一致（便于文档截图与验证） */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  const reset = process.argv.includes('--reset');
  migrate();
  if (reset) {
    truncateAll();
    console.log('[seed] 已清空全部业务数据');
  }

  const exists = db.pluck('SELECT COUNT(*) FROM users');
  if (exists > 0 && !reset) {
    console.log(`[seed] 检测到已有 ${exists} 个用户，跳过（如需重建请执行 npm run reset）`);
    return;
  }

  const now = nowIso();
  const pwdHash = hashPasswordSync(PASSWORD);

  db.tx(() => {
    // ---------------- 班次 ----------------
    const shiftIds = {};
    for (const s of SHIFTS) {
      db.run(
        `INSERT INTO shifts (code, name, start_time, end_time, seq, color, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        s.code, s.name, s.startTime, s.endTime, s.seq, s.color, now, now
      );
      shiftIds[s.code] = db.pluck('SELECT id FROM shifts WHERE code = ?', s.code);
    }

    // ---------------- 工作类型 ----------------
    const wtIds = {};
    for (const w of WORK_TYPES) {
      db.run(
        `INSERT INTO work_types (code, name, description, color, sort_order, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        w.code, w.name, w.description, w.color, w.sortOrder, now, now
      );
      wtIds[w.code] = db.pluck('SELECT id FROM work_types WHERE code = ?', w.code);
    }

    // ---------------- 管理员 ----------------
    db.run(
      `INSERT INTO users (employee_no, name, password_hash, role, status, created_at, updated_at)
       VALUES ('admin', '管理员', ?, 'admin', 'active', ?, ?)`,
      pwdHash, now, now
    );
    const adminId = db.pluck("SELECT id FROM users WHERE employee_no = 'admin'");

    // ---------------- 邀请码 ----------------
    db.run(
      `INSERT INTO invites (code, max_uses, used_count, expires_at, created_by, created_at)
       VALUES ('TEAM2025', 100, 0, ?, ?, ?)`,
      addDays(today(), 365), adminId, now
    );

    // ---------------- 员工 ----------------
    const rnd = seededRandom(20250101);
    const userIds = [];
    EMPLOYEES.forEach((name, i) => {
      const no = `emp${String(i + 1).padStart(3, '0')}`;
      db.run(
        `INSERT INTO users (employee_no, name, password_hash, role, status, created_at, updated_at)
         VALUES (?, ?, ?, 'employee', 'active', ?, ?)`,
        no, name, pwdHash, now, now
      );
      userIds.push(db.pluck('SELECT id FROM users WHERE employee_no = ?', no));
    });

    // ============================================================
    // 历史周期（已发布）—— 提供轮转历史
    // ============================================================
    const histStart = addDays(today(), -21);
    const histEnd = addDays(today(), -15);
    db.run(
      `INSERT INTO periods (name, start_date, end_date, max_shifts_per_day, max_shifts_per_week,
                            forbid_consecutive, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 5, 1, 'published', ?, ?)`,
      `历史周期 ${histStart.slice(5)} ~ ${histEnd.slice(5)}`, histStart, histEnd, now, now
    );
    const histPeriodId = db.pluck('SELECT id FROM periods ORDER BY id DESC LIMIT 1');

    // 历史：每天早/中/晚三个班次
    const histSlots = [];
    for (const d of dateRange(histStart, histEnd)) {
      for (const code of ['MORNING', 'AFTERNOON', 'NIGHT']) {
        db.run(
          `INSERT INTO period_slots (period_id, work_date, shift_id) VALUES (?, ?, ?)`,
          histPeriodId, d, shiftIds[code]
        );
        histSlots.push({ date: d, shiftId: shiftIds[code] });
      }
    }

    // 历史：每班次配 2 种工作，各 1-2 人
    const histAssignments = [];
    const allWtIds = Object.values(wtIds);
    for (const slot of histSlots) {
      const picks = [allWtIds[0], allWtIds[1]]; // 历史只排前台/后厨，让轮转有起点
      for (const wtId of picks) {
        const need = rnd() < 0.4 ? 2 : 1;
        db.run(
          `INSERT OR IGNORE INTO slot_requirements (period_id, work_date, shift_id, work_type_id, need_count)
           VALUES (?, ?, ?, ?, ?)`,
          histPeriodId, slot.date, slot.shiftId, wtId, need
        );
        for (let k = 0; k < need; k += 1) {
          histAssignments.push({ date: slot.date, shiftId: slot.shiftId, wtId });
        }
      }
    }

    // 历史分配：按工作类型独立轮询，且保证"同一班次内不重复同一人"
    // 这样不同员工的历史结构不同，轮转算法才有发挥空间
    db.run(
      `INSERT INTO schedule_runs (period_id, algo_version, seed, input_hash, status,
        total_needed, total_filled, fill_rate, metrics_json, gaps_json, rounds, duration_ms, created_by, created_at)
       VALUES (?, 'seed-history', 1, 'seed', 'published', ?, ?, 1.0, NULL, NULL, 0, 0, ?, ?)`,
      histPeriodId, histAssignments.length, histAssignments.length, adminId, now
    );
    const histRunId = db.pluck('SELECT id FROM schedule_runs WHERE period_id = ?', histPeriodId);

    const cursorByWt = new Map();
    // 记录每个 (date, shiftId) 已被本批次用到的人，避免同班次重复
    const usedInSlot = new Map();
    for (const a of histAssignments) {
      const slotKey = `${a.date}|${a.shiftId}`;
      if (!usedInSlot.has(slotKey)) usedInSlot.set(slotKey, new Set());
      const used = usedInSlot.get(slotKey);

      let cur = cursorByWt.get(a.wtId) || 0;
      let userId = null;
      for (let tries = 0; tries < userIds.length; tries += 1) {
        const candidate = userIds[(cur + tries) % userIds.length];
        if (!used.has(candidate)) {
          userId = candidate;
          cur = cur + tries + 1;
          break;
        }
      }
      if (userId === null) continue; // 该班次人已满，跳过
      cursorByWt.set(a.wtId, cur);
      used.add(userId);

      db.run(
        `INSERT INTO assignments (run_id, period_id, work_date, shift_id, work_type_id, user_id, status, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 'algo', ?)`,
        histRunId, histPeriodId, a.date, a.shiftId, a.wtId, userId, now
      );
    }

    // ============================================================
    // 当前周期（开放报名）
    // ============================================================
    const curStart = addDays(today(), 1);
    const curEnd = addDays(today(), 7);
    db.run(
      `INSERT INTO periods (name, start_date, end_date, max_shifts_per_day, max_shifts_per_week,
                            forbid_consecutive, status, enrollment_deadline, created_at, updated_at)
       VALUES (?, ?, ?, 1, 4, 1, 'enrolling', ?, ?, ?)`,
      `本周排班 ${curStart.slice(5)} ~ ${curEnd.slice(5)}`, curStart, curEnd, addDays(today(), 1), now, now
    );
    const curPeriodId = db.pluck('SELECT id FROM periods ORDER BY id DESC LIMIT 1');

    const curDates = dateRange(curStart, curEnd);
    const shiftCodes = ['MORNING', 'AFTERNOON', 'NIGHT'];

    // 需求配置：每天每班次按工作类型给不同人数，制造真实的供需差异
    const needMatrix = {
      MORNING: { FRONT: 2, KITCHEN: 2, CLEAN: 1, SUPPLY: 0, EVENT: 0 },
      AFTERNOON: { FRONT: 2, KITCHEN: 1, CLEAN: 1, SUPPLY: 1, EVENT: 1 },
      NIGHT: { FRONT: 1, KITCHEN: 0, CLEAN: 1, SUPPLY: 0, EVENT: 0 },
    };

    for (const d of curDates) {
      for (const code of shiftCodes) {
        db.run(
          `INSERT INTO period_slots (period_id, work_date, shift_id) VALUES (?, ?, ?)`,
          curPeriodId, d, shiftIds[code]
        );
        for (const [wtCode, need] of Object.entries(needMatrix[code])) {
          if (need > 0) {
            db.run(
              `INSERT INTO slot_requirements (period_id, work_date, shift_id, work_type_id, need_count)
               VALUES (?, ?, ?, ?, ?)`,
              curPeriodId, d, shiftIds[code], wtIds[wtCode], need
            );
          }
        }
      }
    }

    // ---------------- 报名（全部 20 名员工） ----------------
    const wtCodeList = ['FRONT', 'KITCHEN', 'CLEAN', 'SUPPLY', 'EVENT'];
    userIds.forEach((userId, i) => {
      // 每人报名 2-4 种工作，优先级按报名顺序
      const count = 2 + (i % 3);
      const picks = [];
      for (let k = 0; k < count; k += 1) {
        picks.push(wtCodeList[(i + k) % wtCodeList.length]);
      }
      const uniq = [...new Set(picks)];

      // 个人上限：7 天周期内允许 6 班（给换班留出弹性，但仍受每周上限约束）
      db.run(
        `INSERT INTO enrollments (period_id, user_id, max_shifts, status, submitted_at, created_at, updated_at)
         VALUES (?, ?, ?, 'submitted', ?, ?, ?)`,
        curPeriodId, userId, 6, now, now, now
      );
      const enrollId = db.pluck('SELECT id FROM enrollments WHERE period_id = ? AND user_id = ?', curPeriodId, userId);

      uniq.forEach((code, k) => {
        db.run(
          `INSERT INTO enrollment_work_types (enrollment_id, work_type_id, priority) VALUES (?, ?, ?)`,
          enrollId, wtIds[code], Math.min(k + 1, 3)
        );
      });

      // 请假：每 7 人有 1 人请 1 天假
      if (i % 7 === 3) {
        const leaveDate = curDates[i % curDates.length];
        db.run(
          `INSERT INTO unavailability_dates (period_id, user_id, work_date, reason) VALUES (?, ?, ?, ?)`,
          curPeriodId, userId, leaveDate, '个人事由'
        );
      }
    });
  });

  // ---------------- 汇总输出 ----------------
  const stats = {
    users: db.pluck('SELECT COUNT(*) FROM users'),
    workTypes: db.pluck('SELECT COUNT(*) FROM work_types'),
    shifts: db.pluck('SELECT COUNT(*) FROM shifts'),
    periods: db.pluck('SELECT COUNT(*) FROM periods'),
    enrollments: db.pluck('SELECT COUNT(*) FROM enrollments'),
    requirements: db.pluck('SELECT COUNT(*) FROM slot_requirements'),
    historyAssignments: db.pluck(
      `SELECT COUNT(*) FROM assignments a JOIN periods p ON p.id = a.period_id WHERE p.status = 'published'`
    ),
  };

  console.log('[seed] 完成');
  console.log(`  用户 ${stats.users}（1 管理员 + 20 员工）`);
  console.log(`  工作类型 ${stats.workTypes} / 班次 ${stats.shifts}`);
  console.log(`  周期 ${stats.periods}（1 历史已发布 + 1 当前开放报名）`);
  console.log(`  报名 ${stats.enrollments} 条 / 需求 ${stats.requirements} 条 / 历史排班 ${stats.historyAssignments} 条`);
  console.log('');
  console.log('  演示账号：');
  console.log('    管理员  admin  / 123456');
  console.log('    员工    emp001 ~ emp020 / 123456');
  console.log('    邀请码  TEAM2025');
  console.log('');
  const cur = db.get(`SELECT id, name FROM periods WHERE status = 'enrolling' ORDER BY id DESC LIMIT 1`);
  if (cur) console.log(`  当前周期 ID = ${cur.id}（${cur.name}）`);
}

main();
db.close();
