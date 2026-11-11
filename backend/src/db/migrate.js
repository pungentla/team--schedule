'use strict';

/**
 * 版本化迁移 —— 用 PRAGMA user_version 记录已应用的版本。
 * schema.sql 全部使用 CREATE ... IF NOT EXISTS，因此可重复执行（幂等）。
 */

const db = require('./db');
const { ensureAlias } = require('../repositories/discussionAliasRepo');

const CURRENT_VERSION = 30;

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
        if (fromVersion < 29) migratePushPreferences();
        const userColumns = new Set(db.all('PRAGMA table_xinfo(users)').map(column => column.name));
        for (const [column, definition] of [
          ['nickname', 'TEXT'],
          ['nickname_changed_at', 'TEXT'],
          ['nickname_enabled', 'INTEGER NOT NULL DEFAULT 1 CHECK (nickname_enabled IN (0, 1))'],
          ['display_name', 'TEXT GENERATED ALWAYS AS (COALESCE(CASE WHEN nickname_enabled = 1 THEN nickname END, name)) VIRTUAL'],
        ]) {
          if (!userColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
        }
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
        if (!db.all('PRAGMA table_info(work_types)').some(column => column.name === 'allow_weekday_selection')) {
          db.exec('ALTER TABLE work_types ADD COLUMN allow_weekday_selection INTEGER NOT NULL DEFAULT 0 CHECK (allow_weekday_selection IN (0, 1))');
        }
        if (!db.all('PRAGMA table_info(work_types)').some(column => column.name === 'fill_all_enrolled')) {
          db.exec('ALTER TABLE work_types ADD COLUMN fill_all_enrolled INTEGER NOT NULL DEFAULT 0 CHECK (fill_all_enrolled IN (0, 1))');
        }
        if (!db.all('PRAGMA table_info(enrollment_work_types)').some(column => column.name === 'weekdays_json')) {
          db.exec('ALTER TABLE enrollment_work_types ADD COLUMN weekdays_json TEXT');
        }
        if (!db.all('PRAGMA table_info(schedule_runs)').some(column => column.name === 'reference_history')) {
          db.exec('ALTER TABLE schedule_runs ADD COLUMN reference_history INTEGER CHECK (reference_history IN (0, 1))');
        }
        if (!db.all('PRAGMA table_info(discussion_replies)').some(column => column.name === 'parent_reply_id')) {
          db.exec('ALTER TABLE discussion_replies ADD COLUMN parent_reply_id INTEGER REFERENCES discussion_replies(id) ON DELETE SET NULL');
        }
        const anonymousAuthors = db.all(`SELECT id AS topicId, author_id AS userId FROM discussion_topics
          WHERE is_anonymous = 1 AND author_id IS NOT NULL
          UNION SELECT r.topic_id, r.author_id FROM discussion_replies r JOIN discussion_topics t ON t.id = r.topic_id
          WHERE t.is_anonymous = 1 AND r.author_id IS NOT NULL`);
        for (const { topicId, userId } of anonymousAuthors) ensureAlias(topicId, userId);
        if (fromVersion < 27) {
          const { enrollmentOpened } = require('../services/systemNoticeService');
          for (const period of db.all("SELECT id,name FROM periods WHERE status='enrolling' AND deleted_at IS NULL")) {
            enrollmentOpened(period, { sendPush: false });
          }
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

function migratePushPreferences() {
  const columns = db.all('PRAGMA table_info(push_events)').map(column => column.name);
  if (columns.includes('system_notice_kind')) {
    db.exec('ALTER TABLE push_events RENAME COLUMN system_notice_kind TO push_kind');
  } else if (!columns.includes('push_kind')) {
    db.exec('ALTER TABLE push_events ADD COLUMN push_kind TEXT');
  }
  if (db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_notice_opt_outs'")) {
    db.exec(`INSERT OR IGNORE INTO push_opt_outs (user_id,kind) SELECT user_id,kind FROM system_notice_opt_outs;
      DROP TABLE system_notice_opt_outs;`);
  }
  db.run(`UPDATE push_events SET push_kind=CASE
    WHEN json_extract(payload, '$.tag') LIKE 'shihe-enrollment-open-%' THEN 'enrollment_open'
    WHEN json_extract(payload, '$.tag') LIKE 'shihe-proxy-enrollment-%' THEN 'proxy_enrollment'
    WHEN json_extract(payload, '$.tag')='shihe-new-topics' THEN 'new_topics'
    WHEN json_extract(payload, '$.tag') LIKE 'shihe-topic-reply-%' THEN CASE
      WHEN json_extract(payload, '$.body')='有人回复了你的评论。' THEN 'direct_reply' ELSE 'topic_replies' END
    WHEN json_extract(payload, '$.tag') LIKE 'shihe-topic-%' THEN 'topic_likes'
    WHEN json_extract(payload, '$.tag') LIKE 'shihe-swap-%' OR json_extract(payload, '$.tag')='shihe-schedule-change' THEN 'swap'
    WHEN json_extract(payload, '$.tag') LIKE 'shihe-announcement-%' THEN 'announcement'
  END WHERE push_kind IS NULL AND json_valid(payload)`);
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
    'push_opt_outs',
    'system_notices',
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
    'discussion_aliases',
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
