'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-migration-'));
process.env.DB_FILE = path.join(tmp, 'legacy.db');
const db = require('../src/db/db');
const { migrate, CURRENT_VERSION } = require('../src/db/migrate');

test('v1 原有用户、报名与已发布排班无损升级，新增角色不默认授予主副资格', () => {
  const legacy = db.readSchemaSql().split('\n').filter((line) => !['duty_pairs_json', 'requires_roles', 'duty_role', 'weekdays_json', 'default_need', 'weekly_assignments_json', 'is_fixed', 'revision', 'work_type_ids_json', 'shift_ids_json', 'deleted_at', 'deleted_by', 'submitted_work_type_ids_json', 'withdrawn_work_type_ids_json'].some((column) => line.includes(column))).join('\n');
  db.exec(legacy);
  db.exec(`INSERT INTO roles(code,name) VALUES ('employee','员工');
    INSERT INTO users(id,employee_no,name,password_hash,created_at,updated_at) VALUES (1,'E1','旧员工','fixture','now','now');
    INSERT INTO work_types(id,code,name,created_at,updated_at) VALUES (1,'OLD','旧工作','now','now');
    INSERT INTO shifts(id,code,name,start_time,end_time,seq,created_at,updated_at) VALUES (1,'AM','早班','08:00','12:00',1,'now','now');
    INSERT INTO periods(id,name,start_date,end_date,status,created_at,updated_at) VALUES (1,'历史','2026-11-05','2026-11-05','published','now','now');
    INSERT INTO enrollments(id,period_id,user_id,status,created_at,updated_at) VALUES (1,1,1,'submitted','now','now');
    INSERT INTO enrollment_work_types(enrollment_id,work_type_id,priority) VALUES (1,1,2);
    INSERT INTO schedule_runs(id,period_id,algo_version,seed,status,created_at) VALUES (1,1,'1.0.0',42,'published','now');
    INSERT INTO assignments(id,run_id,period_id,work_date,shift_id,work_type_id,user_id,created_at) VALUES (1,1,1,'2026-11-05',1,1,1,'now');
    PRAGMA user_version=1;`);
  assert.deepEqual(migrate(), { fromVersion: 1, toVersion: CURRENT_VERSION });
  assert.equal(db.pluck('SELECT COUNT(*) FROM users'), 1);
  assert.equal(db.get('SELECT duty_role,priority FROM enrollment_work_types').duty_role, 'member');
  assert.equal(db.get('SELECT duty_role,priority FROM enrollment_work_types').priority, 2);
  const assignment = db.get('SELECT * FROM assignments WHERE id=1');
  assert.equal(assignment.status, 'active');
  assert.equal(assignment.user_id, 1);
  assert.equal(assignment.duty_role, 'member');
  const work = db.get('SELECT * FROM work_types WHERE id=1');
  assert.equal(db.get('SELECT * FROM periods WHERE id=1').work_type_ids_json, null);
  assert.equal(db.get('SELECT * FROM periods WHERE id=1').shift_ids_json, null);
  assert.equal(work.requires_roles, 0);
  assert.equal(work.default_need, 1);
  assert.deepEqual(JSON.parse(work.weekdays_json), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(migrate(), { fromVersion: CURRENT_VERSION, toVersion: CURRENT_VERSION });
});
test('v11 升级保留旧话题并能原样读写图片二进制', () => {
  db.close();
  db.open(path.join(tmp, 'discussion-v11.db'));
  migrate();
  db.exec(`DROP TABLE discussion_images;
    INSERT INTO discussion_topics (id, category, title, content, created_at) VALUES (1, 'chat', '旧话题', '正文', 'now');
    PRAGMA user_version = 11;`);
  assert.deepEqual(migrate(), { fromVersion: 11, toVersion: CURRENT_VERSION });
  assert.equal(db.pluck('SELECT title FROM discussion_topics WHERE id = 1'), '旧话题');
  const image = Buffer.from([0, 127, 128, 255]);
  db.run("INSERT INTO discussion_images (topic_id, position, mime_type, content) VALUES (1, 1, 'image/png', ?)", image);
  assert.deepEqual(Buffer.from(db.pluck('SELECT content FROM discussion_images')), image);
});

test('v15 升级保留原有评论，删除被引用的评论时保留新回复', () => {
  db.close();
  db.open(path.join(tmp, 'discussion-v15.db'));
  db.exec(db.readSchemaSql().split('\n').filter(line => !line.includes('parent_reply_id')).join('\n'));
  db.exec(`INSERT INTO discussion_topics (id, category, title, content, created_at) VALUES (1, 'chat', '旧话题', '正文', 'now');
    INSERT INTO discussion_replies (id, topic_id, content, created_at) VALUES (1, 1, '旧评论', 'now');
    PRAGMA user_version = 15;`);
  assert.deepEqual(migrate(), { fromVersion: 15, toVersion: CURRENT_VERSION });
  assert.equal(db.pluck('SELECT content FROM discussion_replies WHERE id=1'), '旧评论');
  assert.equal(db.pluck('SELECT parent_reply_id FROM discussion_replies WHERE id=1'), null);
  db.run("INSERT INTO discussion_replies (id, topic_id, parent_reply_id, content, created_at) VALUES (2, 1, 1, '新回复', 'now')");
  db.run('DELETE FROM discussion_replies WHERE id=1');
  assert.equal(db.pluck('SELECT content FROM discussion_replies WHERE id=2'), '新回复');
  assert.equal(db.pluck('SELECT parent_reply_id FROM discussion_replies WHERE id=2'), null);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
});

test('v16 升级保留话题、评论、图片和原公告，旧内容不会被标记未读', () => {
  db.close();
  db.open(path.join(tmp, 'discussions-v16.db'));
  db.exec(db.readSchemaSql()
    .replace("'share', 'poll'", "'share'")
    .replace(/,\n  poll_closes_at[^\n]+/, '')
    .replace(/,\n  poll_mode[^\n]+/, '')
    .replace(/,\n  is_anonymous[^\n]+/, '')
    .replace('CREATE TABLE IF NOT EXISTS announcements (\n  id            INTEGER PRIMARY KEY AUTOINCREMENT',
      'CREATE TABLE IF NOT EXISTS announcements (\n  id            INTEGER PRIMARY KEY CHECK (id = 1)'));
  db.exec(`DROP TABLE discussion_unread_replies;
    DROP TABLE discussion_poll_votes;
    DROP TABLE discussion_poll_options;
    INSERT INTO discussion_topics (id, category, title, content, created_at) VALUES (1, 'chat', '旧话题', '正文', 'now'), (9, 'chat', '已删除', '', 'now');
    DELETE FROM discussion_topics WHERE id = 9;
    INSERT INTO discussion_replies (id, topic_id, content, created_at) VALUES (1, 1, '旧评论', 'now');
    INSERT INTO discussion_images (topic_id, position, mime_type, content) VALUES (1, 1, 'image/png', X'01');
    INSERT INTO announcements (id, title, content, published_at) VALUES (1, '旧公告', '正文', 'now');
    PRAGMA user_version = 16;`);
  assert.deepEqual(migrate(), { fromVersion: 16, toVersion: CURRENT_VERSION });
  assert.equal(db.pluck('SELECT is_anonymous FROM discussion_topics WHERE id = 1'), 0);
  assert.equal(db.pluck('SELECT content FROM discussion_replies WHERE id = 1'), '旧评论');
  assert.equal(db.pluck('SELECT COUNT(*) FROM discussion_images'), 1);
  assert.equal(db.pluck('SELECT title FROM announcements WHERE id = 1'), '旧公告');
  assert.equal(db.pluck('SELECT COUNT(*) FROM discussion_unread_replies'), 0);
  assert.equal(db.run("INSERT INTO discussion_topics (category, title, content, created_at) VALUES ('poll', '投票', '', 'now')").lastInsertRowid, 10);
  assert.equal(db.run("INSERT INTO announcements (title, content, published_at) VALUES ('新公告', '正文', 'now')").lastInsertRowid, 2);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
});

test('v17 升级保留既有单选投票和选票，并支持同一账号勾选多个选项', () => {
  db.close();
  db.open(path.join(tmp, 'poll-v17.db'));
  db.exec(db.readSchemaSql()
    .replace(/,\n  poll_closes_at[^\n]+/, '')
    .replace(/,\n  poll_mode[^\n]+/, '')
    .replace('PRIMARY KEY (topic_id, user_id, position)', 'PRIMARY KEY (topic_id, user_id)'));
  db.exec(`INSERT INTO roles (code, name) VALUES ('employee', '员工');
    INSERT INTO users (id, employee_no, name, password_hash, created_at, updated_at) VALUES (1, 'E1', '员工', 'fixture', 'now', 'now');
    INSERT INTO discussion_topics (id, category, title, content, created_at) VALUES (1, 'poll', '旧投票', '', 'now');
    INSERT INTO discussion_poll_options (topic_id, position, label) VALUES (1, 1, '甲'), (1, 2, '乙');
    INSERT INTO discussion_poll_votes (topic_id, user_id, position) VALUES (1, 1, 2);
    PRAGMA user_version = 17;`);
  assert.deepEqual(migrate(), { fromVersion: 17, toVersion: CURRENT_VERSION });
  assert.equal(db.pluck('SELECT poll_mode FROM discussion_topics WHERE id = 1'), 'single');
  assert.equal(db.pluck('SELECT poll_closes_at FROM discussion_topics WHERE id = 1'), null);
  assert.equal(db.pluck('SELECT position FROM discussion_poll_votes WHERE topic_id = 1 AND user_id = 1'), 2);
  db.exec(`INSERT INTO discussion_topics (id, category, title, content, created_at, poll_mode) VALUES (2, 'poll', '新投票', '', 'now', 'multiple');
    INSERT INTO discussion_poll_options (topic_id, position, label) VALUES (2, 1, '甲'), (2, 2, '乙');
    INSERT INTO discussion_poll_votes (topic_id, user_id, position) VALUES (2, 1, 1), (2, 1, 2);`);
  assert.equal(db.pluck('SELECT COUNT(*) FROM discussion_poll_votes WHERE topic_id = 2 AND user_id = 1'), 2);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
});

test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
