'use strict';

/**
 * 版本化迁移 —— 用 PRAGMA user_version 记录已应用的版本。
 * schema.sql 全部使用 CREATE ... IF NOT EXISTS，因此可重复执行（幂等）。
 */

const db = require('./db');

const CURRENT_VERSION = 15;

function migrate() {
  db.open();

  const fromVersion = Number(db.pluck('PRAGMA user_version') || 0);

  if (fromVersion < CURRENT_VERSION) {
    db.tx(() => {
      // 整份 schema 幂等执行
      db.exec(db.readSchemaSql());

      if (fromVersion < 9) migrateLegacySchema();
      db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
    });
  }

  const toVersion = Number(db.pluck('PRAGMA user_version') || 0);
  return { fromVersion, toVersion };
}

function migrateLegacySchema() {
  // 基础枚举数据（角色）—— 用 INSERT OR IGNORE 保证可重复
  db.run(
    `INSERT OR IGNORE INTO roles (code, name) VALUES ('super_admin', '超级管理员'), ('admin', '管理员'), ('employee', '员工')`
  );

  // 历史报名保持普通成员，启用主副后需要员工明确选择角色。
  const columns = [
    ['enrollments', 'submitted_work_type_ids_json', 'TEXT'],
    ['enrollments', 'withdrawn_work_type_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['periods', 'deleted_at', 'TEXT'],
    ['periods', 'deleted_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
    ['periods', 'work_type_ids_json', 'TEXT'],
    ['periods', 'shift_ids_json', 'TEXT'],
    ['work_types', 'requires_roles', 'INTEGER NOT NULL DEFAULT 0 CHECK (requires_roles IN (0, 1))'],
    ['work_types', 'weekdays_json', "TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]'"],
    ['work_types', 'default_need', 'INTEGER NOT NULL DEFAULT 1 CHECK (default_need BETWEEN 0 AND 99)'],
    ['work_types', 'weekly_assignments_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['work_types', 'duty_pairs_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['assignments', 'is_fixed', 'INTEGER NOT NULL DEFAULT 0 CHECK (is_fixed IN (0, 1))'],
    ['schedule_runs', 'revision', 'INTEGER NOT NULL DEFAULT 0'],
    ['enrollment_work_types', 'duty_role', "TEXT NOT NULL DEFAULT 'member' CHECK (duty_role IN ('member', 'primary', 'deputy', 'both'))"],
    ['assignments', 'duty_role', "TEXT NOT NULL DEFAULT 'member' CHECK (duty_role IN ('member', 'primary', 'deputy'))"],
  ];
  for (const [table, column, definition] of columns) {
    if (!db.all(`PRAGMA table_info(${table})`).some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  db.run(`UPDATE enrollments SET submitted_work_type_ids_json=(SELECT json_group_array(work_type_id) FROM enrollment_work_types WHERE enrollment_id=enrollments.id) WHERE status='submitted' AND submitted_work_type_ids_json IS NULL`);
  // Different jobs may share a shift; one person cannot occupy two seats of the same job.
  db.exec(`DROP INDEX IF EXISTS uq_assignment_active_person_slot;
    CREATE UNIQUE INDEX uq_assignment_active_person_slot ON assignments(run_id,user_id,work_date,shift_id,work_type_id) WHERE status='active'`);
  db.run('UPDATE work_types SET default_need=2 WHERE requires_roles=1 AND default_need=1');
  // 旧系统最早创建的启用管理员承接账号治理权限。
  if (!db.pluck("SELECT COUNT(*) FROM users WHERE role='super_admin'")) {
    db.run("UPDATE users SET role='super_admin' WHERE id=(SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1)");
  }
}

/** 删除全部业务数据（保留表结构），用于 reset */
function truncateAll() {
  const tables = [
    'swap_participants',
    'swap_requests',
    'assignments',
    'schedule_runs',
    'slot_requirements',
    'availability_slots',
    'unavailability_dates',
    'enrollment_work_types',
    'enrollments',
    'period_slots',
    'periods',
    'shifts',
    'work_types',
    'sessions',
    'invites',
    'audit_logs',
    'announcements',
    'discussion_replies',
    'discussion_images',
    'discussion_likes',
    'discussion_topics',
    'push_events',
    'push_subscriptions',
    'users',
  ];
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec(`DELETE FROM sqlite_sequence`);
  db.exec('PRAGMA foreign_keys = ON');
}

module.exports = { migrate, truncateAll, CURRENT_VERSION };

// 允许直接 node src/db/migrate.js
if (require.main === module) {
  const { fromVersion, toVersion } = migrate();
  console.log(`[migrate] user_version ${fromVersion} -> ${toVersion}`);
  console.log(`[migrate] db file: ${require('../config').config.dbFile}`);
  db.close();
}
