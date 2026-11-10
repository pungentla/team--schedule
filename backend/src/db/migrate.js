'use strict';

/**
 * 版本化迁移 —— 用 PRAGMA user_version 记录已应用的版本。
 * schema.sql 全部使用 CREATE ... IF NOT EXISTS，因此可重复执行（幂等）。
 */

const db = require('./db');

const CURRENT_VERSION = 20;

function migrate() {
  db.open();

  const fromVersion = Number(db.pluck('PRAGMA user_version') || 0);

  if (fromVersion < CURRENT_VERSION) {
    const topicColumns = db.all('PRAGMA table_info(discussion_topics)');
    const rebuildTopics = topicColumns.length > 0 && !topicColumns.some(column => column.name === 'is_anonymous');
    if (rebuildTopics) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.tx(() => {
        if (rebuildTopics) migrateDiscussionTopics();
        const announcements = db.pluck("SELECT sql FROM sqlite_master WHERE name = 'announcements'");
        const rebuildAnnouncements = announcements && !announcements.includes('AUTOINCREMENT');
        if (rebuildAnnouncements) db.exec('ALTER TABLE announcements RENAME TO announcements_legacy');
        const rebuildVotes = db.all('PRAGMA table_info(discussion_poll_votes)').some(column => column.name === 'position' && !column.pk);
        if (rebuildVotes) db.exec('ALTER TABLE discussion_poll_votes RENAME TO discussion_poll_votes_legacy');
        db.exec(db.readSchemaSql());
        if (rebuildAnnouncements) {
          db.exec(`INSERT INTO announcements (id, title, content, published_by, published_at)
            SELECT id, title, content, published_by, published_at FROM announcements_legacy;
            DROP TABLE announcements_legacy;`);
        }
        if (rebuildVotes) {
          db.exec(`INSERT INTO discussion_poll_votes (topic_id, user_id, position)
            SELECT topic_id, user_id, position FROM discussion_poll_votes_legacy;
            DROP TABLE discussion_poll_votes_legacy;`);
        }
        if (!db.all('PRAGMA table_info(discussion_topics)').some(column => column.name === 'poll_mode')) {
          db.exec("ALTER TABLE discussion_topics ADD COLUMN poll_mode TEXT NOT NULL DEFAULT 'single' CHECK (poll_mode IN ('single', 'multiple'))");
        }
        if (!db.all('PRAGMA table_info(discussion_topics)').some(column => column.name === 'poll_closes_at')) {
          db.exec('ALTER TABLE discussion_topics ADD COLUMN poll_closes_at TEXT');
        }

        if (fromVersion < 9) migrateLegacySchema();
        if (!db.all('PRAGMA table_info(discussion_replies)').some(column => column.name === 'parent_reply_id')) {
          db.exec('ALTER TABLE discussion_replies ADD COLUMN parent_reply_id INTEGER REFERENCES discussion_replies(id) ON DELETE SET NULL');
        }
        if (rebuildTopics && db.get('PRAGMA foreign_key_check')) throw new Error('数据库迁移后存在无效引用');
        db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
      });
    } finally {
      if (rebuildTopics) db.exec('PRAGMA foreign_keys = ON');
    }
  }

  const toVersion = Number(db.pluck('PRAGMA user_version') || 0);
  return { fromVersion, toVersion };
}

function migrateDiscussionTopics() {
  const sequence = db.pluck("SELECT seq FROM sqlite_sequence WHERE name = 'discussion_topics'");
  db.exec(`CREATE TABLE discussion_topics_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    category TEXT NOT NULL CHECK (category IN ('chat', 'feedback', 'share', 'poll')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    article_url TEXT,
    created_at TEXT NOT NULL,
    is_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (is_anonymous IN (0, 1))
  );
  INSERT INTO discussion_topics_new (id, author_id, category, title, content, article_url, created_at)
    SELECT id, author_id, category, title, content, article_url, created_at FROM discussion_topics;
  DROP TABLE discussion_topics;
  ALTER TABLE discussion_topics_new RENAME TO discussion_topics;`);
  if (sequence != null) {
    db.run("DELETE FROM sqlite_sequence WHERE name = 'discussion_topics'");
    db.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('discussion_topics', ?)", sequence);
  }
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
    'discussion_unread_replies',
    'discussion_replies',
    'discussion_images',
    'discussion_unread_likes',
    'discussion_likes',
    'discussion_poll_votes',
    'discussion_poll_options',
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
