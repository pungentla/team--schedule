'use strict';

/**
 * 版本化迁移 —— 用 PRAGMA user_version 记录已应用的版本。
 * schema.sql 全部使用 CREATE ... IF NOT EXISTS，因此可重复执行（幂等）。
 */

const db = require('./db');

const CURRENT_VERSION = 1;

function migrate() {
  db.open();

  const fromVersion = Number(db.pluck('PRAGMA user_version') || 0);

  if (fromVersion < CURRENT_VERSION) {
    // 整份 schema 幂等执行
    db.exec(db.readSchemaSql());

    // 基础枚举数据（角色）—— 用 INSERT OR IGNORE 保证可重复
    db.run(
      `INSERT OR IGNORE INTO roles (code, name) VALUES ('admin', '管理员'), ('employee', '员工')`
    );

    db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
  }

  const toVersion = Number(db.pluck('PRAGMA user_version') || 0);
  return { fromVersion, toVersion };
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
