-- ============================================================================
-- 排班宝 TeamShift 数据库结构
-- 约定：日期统一 TEXT 'YYYY-MM-DD'，时间戳 TEXT ISO8601（UTC）
-- 建表顺序受外键约束限制：被引用的表必须先创建
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 角色与用户
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_no   TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  nickname      TEXT,
  nickname_changed_at TEXT,
  nickname_enabled INTEGER NOT NULL DEFAULT 1 CHECK (nickname_enabled IN (0, 1)),
  display_name  TEXT GENERATED ALWAYS AS (COALESCE(CASE WHEN nickname_enabled = 1 THEN nickname END, name)) VIRTUAL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'employee' REFERENCES roles(code),
  phone         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id),
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  due_at TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  repeat_kind TEXT NOT NULL DEFAULT 'none' CHECK (repeat_kind IN ('none', 'weekly', 'monthly')),
  repeat_day INTEGER,
  repeat_group_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  next_todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  completed_at TEXT,
  archived_at TEXT,
  completion_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (visibility = 'public' OR assignee_id = created_by)
);
CREATE INDEX IF NOT EXISTS idx_todos_assignee ON todos(assignee_id, completed_at, due_at);
CREATE INDEX IF NOT EXISTS idx_todos_creator ON todos(created_by, completed_at, due_at);
CREATE INDEX IF NOT EXISTS idx_todos_repeat ON todos(repeat_group_id);

CREATE TABLE IF NOT EXISTS todo_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id),
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todo_items_parent ON todo_items(todo_id, position);

CREATE TABLE IF NOT EXISTS todo_reminders (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  notified_at TEXT,
  PRIMARY KEY (todo_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_todo_reminders_due ON todo_reminders(remind_at) WHERE notified_at IS NULL;

CREATE TABLE IF NOT EXISTS todo_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('assigned', 'reminder')),
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_todo_notices_user ON todo_notices(user_id, read_at);

CREATE TABLE IF NOT EXISTS attendance_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL CHECK (ends_at > starts_at),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance_members (
  event_id      INTEGER NOT NULL REFERENCES attendance_events(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  checked_in_at TEXT,
  checked_in_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_member_user ON attendance_members(user_id, event_id);

-- 邀请码：注册时需要
CREATE TABLE IF NOT EXISTS invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  max_uses    INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  used_count  INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at  TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  CHECK (used_count <= max_uses)
);

-- 登录会话：存 token 的 sha256，可实时吊销
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint       TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh         TEXT NOT NULL,
  auth           TEXT NOT NULL,
  reminded_date  TEXT
);

CREATE TABLE IF NOT EXISTS push_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint         TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload          TEXT NOT NULL,
  push_kind        TEXT,
  expires_at       INTEGER NOT NULL,
  next_attempt_at  INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_events_ready ON push_events(next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_push_events_endpoint ON push_events(endpoint);

CREATE TABLE IF NOT EXISTS announcements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  published_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at  TEXT NOT NULL,
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
);

CREATE TABLE IF NOT EXISTS discussion_topics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category    TEXT NOT NULL CHECK (category IN ('chat', 'feedback', 'share', 'poll')),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  article_url TEXT,
  created_at  TEXT NOT NULL,
  is_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (is_anonymous IN (0, 1)),
  poll_mode   TEXT NOT NULL DEFAULT 'single' CHECK (poll_mode IN ('single', 'multiple')),
  poll_closes_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_discussion_topics_category ON discussion_topics(category, id);

CREATE TABLE IF NOT EXISTS discussion_aliases (
  topic_id INTEGER NOT NULL REFERENCES discussion_topics(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  PRIMARY KEY (topic_id, user_id),
  UNIQUE (topic_id, name)
);

CREATE TABLE IF NOT EXISTS discussion_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id    INTEGER NOT NULL REFERENCES discussion_topics(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  parent_reply_id INTEGER REFERENCES discussion_replies(id) ON DELETE SET NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discussion_replies_topic ON discussion_replies(topic_id, id);

CREATE TABLE IF NOT EXISTS discussion_unread_replies (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reply_id INTEGER NOT NULL REFERENCES discussion_replies(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, reply_id)
);
CREATE INDEX IF NOT EXISTS idx_discussion_unread_reply ON discussion_unread_replies(reply_id);

CREATE TABLE IF NOT EXISTS discussion_images (
  topic_id  INTEGER NOT NULL REFERENCES discussion_topics(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
  mime_type TEXT NOT NULL,
  content   BLOB NOT NULL,
  PRIMARY KEY (topic_id, position)
);

CREATE TABLE IF NOT EXISTS discussion_likes (
  topic_id INTEGER NOT NULL REFERENCES discussion_topics(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, user_id)
);

CREATE TABLE IF NOT EXISTS discussion_unread_likes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,
  UNIQUE (topic_id, user_id),
  FOREIGN KEY (topic_id, user_id) REFERENCES discussion_likes(topic_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS discussion_poll_options (
  topic_id INTEGER NOT NULL REFERENCES discussion_topics(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 6),
  label    TEXT NOT NULL,
  PRIMARY KEY (topic_id, position)
);

CREATE TABLE IF NOT EXISTS discussion_poll_votes (
  topic_id INTEGER NOT NULL,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (topic_id, user_id, position),
  FOREIGN KEY (topic_id, position) REFERENCES discussion_poll_options(topic_id, position) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 2. 基础配置：工作类型 / 班次
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_types (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT NOT NULL DEFAULT '#4A90D9',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  requires_roles INTEGER NOT NULL DEFAULT 0 CHECK (requires_roles IN (0, 1)),
  weekdays_json TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  allow_weekday_selection INTEGER NOT NULL DEFAULT 0 CHECK (allow_weekday_selection IN (0, 1)),
  fill_all_enrolled INTEGER NOT NULL DEFAULT 0 CHECK (fill_all_enrolled IN (0, 1)),
  default_need INTEGER NOT NULL DEFAULT 1 CHECK (default_need BETWEEN 0 AND 99),
  weekly_assignments_json TEXT NOT NULL DEFAULT '[]',
  duty_pairs_json TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_types_active ON work_types(active, sort_order);

-- 班次模板。seq 用于判断"是否连续班次"（H8 约束），必须唯一且有序
CREATE TABLE IF NOT EXISTS shifts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  seq         INTEGER NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT '#7B8794',
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (end_time <> start_time)
);

CREATE INDEX IF NOT EXISTS idx_shifts_active_seq ON shifts(active, seq);

-- ---------------------------------------------------------------------------
-- 3. 排班周期
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS periods (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  start_date            TEXT NOT NULL,
  end_date              TEXT NOT NULL,
  max_shifts_per_day    INTEGER NOT NULL DEFAULT 1 CHECK (max_shifts_per_day >= 1),
  max_shifts_per_week   INTEGER NOT NULL DEFAULT 5 CHECK (max_shifts_per_week >= 1),
  forbid_consecutive    INTEGER NOT NULL DEFAULT 1 CHECK (forbid_consecutive IN (0, 1)),
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'enrolling', 'scheduling', 'published', 'archived')),
  enrollment_deadline   TEXT,
  work_type_ids_json    TEXT,
  shift_ids_json        TEXT,
  deleted_at            TEXT,
  deleted_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_periods_status ON periods(status, start_date);

CREATE TABLE IF NOT EXISTS system_notices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('enrollment_open', 'proxy_enrollment', 'new_topics', 'exercise')),
  period_id   INTEGER REFERENCES periods(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_system_notices_user ON system_notices(user_id, kind, period_id);
CREATE INDEX IF NOT EXISTS idx_system_notices_topic_time ON system_notices(created_at) WHERE kind = 'new_topics';

CREATE TABLE IF NOT EXISTS push_opt_outs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL CHECK (kind IN ('enrollment_open', 'proxy_enrollment', 'new_topics', 'direct_reply',
    'topic_replies', 'topic_likes', 'swap', 'announcement', 'next_day_schedule', 'todo', 'exercise')),
  PRIMARY KEY (user_id, kind)
);

-- 开班格子：某天某班次开班了。被 slot_requirements 复合外键引用
CREATE TABLE IF NOT EXISTS period_slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id  INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  work_date  TEXT NOT NULL,
  shift_id   INTEGER NOT NULL REFERENCES shifts(id),
  UNIQUE (period_id, work_date, shift_id)
);

CREATE INDEX IF NOT EXISTS idx_period_slots_period ON period_slots(period_id, work_date);

-- ---------------------------------------------------------------------------
-- 4. 报名
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enrollments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id     INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_shifts    INTEGER CHECK (max_shifts IS NULL OR max_shifts >= 0),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  note          TEXT,
  submitted_at  TEXT,
  submitted_work_type_ids_json TEXT,
  withdrawn_work_type_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (period_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_period ON enrollments(period_id, status);

-- 报名的工作类型 + 意愿优先级（1 最想去）
CREATE TABLE IF NOT EXISTS enrollment_work_types (
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  work_type_id  INTEGER NOT NULL REFERENCES work_types(id),
  priority      INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 3),
  duty_role     TEXT NOT NULL DEFAULT 'member' CHECK (duty_role IN ('member', 'primary', 'deputy', 'both')),
  weekdays_json TEXT,
  PRIMARY KEY (enrollment_id, work_type_id)
);

CREATE INDEX IF NOT EXISTS idx_ewt_work_type ON enrollment_work_types(work_type_id);

-- 精细可用时段（allow-list）。若某人设置了任意一行，则只能排在这些格子里
CREATE TABLE IF NOT EXISTS availability_slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id  INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date  TEXT NOT NULL,
  shift_id   INTEGER NOT NULL REFERENCES shifts(id),
  UNIQUE (period_id, user_id, work_date, shift_id)
);

CREATE INDEX IF NOT EXISTS idx_avail_lookup ON availability_slots(period_id, user_id, work_date);

-- 整日不可用（请假）
CREATE TABLE IF NOT EXISTS unavailability_dates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id  INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date  TEXT NOT NULL,
  reason     TEXT,
  UNIQUE (period_id, user_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_unavail_lookup ON unavailability_dates(period_id, user_id, work_date);

-- ---------------------------------------------------------------------------
-- 5. 需求：某天某班次某工作需要几人
-- 复合外键引用 period_slots(period_id, work_date, shift_id) —— 保证只能给已开的格子配需求
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS slot_requirements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id     INTEGER NOT NULL,
  work_date     TEXT NOT NULL,
  shift_id      INTEGER NOT NULL,
  work_type_id  INTEGER NOT NULL REFERENCES work_types(id),
  need_count    INTEGER NOT NULL DEFAULT 0 CHECK (need_count >= 0),
  FOREIGN KEY (period_id, work_date, shift_id)
    REFERENCES period_slots(period_id, work_date, shift_id) ON DELETE CASCADE,
  UNIQUE (period_id, work_date, shift_id, work_type_id)
);

CREATE INDEX IF NOT EXISTS idx_req_period ON slot_requirements(period_id, work_date);
CREATE INDEX IF NOT EXISTS idx_req_work_type ON slot_requirements(work_type_id);

-- ---------------------------------------------------------------------------
-- 6. 排班结果
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id     INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  algo_version  TEXT NOT NULL,
  seed          INTEGER NOT NULL,
  reference_history INTEGER CHECK (reference_history IN (0, 1)),
  input_hash    TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'discarded')),
  total_needed  INTEGER NOT NULL DEFAULT 0,
  total_filled  INTEGER NOT NULL DEFAULT 0,
  fill_rate     REAL NOT NULL DEFAULT 0,
  metrics_json  TEXT,
  gaps_json     TEXT,
  rounds        INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  revision      INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_period ON schedule_runs(period_id, status);

-- 每个周期最多一个 published run
CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_one_published
  ON schedule_runs(period_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS assignments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE,
  period_id     INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  work_date     TEXT NOT NULL,
  shift_id      INTEGER NOT NULL REFERENCES shifts(id),
  work_type_id  INTEGER NOT NULL REFERENCES work_types(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  source        TEXT NOT NULL DEFAULT 'algo' CHECK (source IN ('algo', 'manual', 'swap')),
  duty_role     TEXT NOT NULL DEFAULT 'member' CHECK (duty_role IN ('member', 'primary', 'deputy')),
  is_fixed      INTEGER NOT NULL DEFAULT 0 CHECK (is_fixed IN (0, 1)),
  released_at   TEXT,
  created_at    TEXT NOT NULL
);

-- 核心防重：在一次排班 run 内，同一个人同一天同一个班次的同一工作只能有一条 active 记录。
-- 这是并发换班场景下的最后兜底。
-- 注意：必须按 run_id 而不是 period_id —— 同一周期可以同时存在 draft 与 published 两套运行，
-- 按 period_id 会让两套运行互相冲突。
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment_active_person_slot
  ON assignments(run_id, user_id, work_date, shift_id, work_type_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_assignment_period_date ON assignments(period_id, work_date, shift_id);
CREATE INDEX IF NOT EXISTS idx_assignment_user ON assignments(period_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_assignment_run ON assignments(run_id, status);
CREATE INDEX IF NOT EXISTS idx_assignment_worktype ON assignments(work_type_id, status);

-- ---------------------------------------------------------------------------
-- 7. 换班申请（发起 + 逐个确认）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS swap_requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id          INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  type               TEXT NOT NULL CHECK (type IN ('transfer', 'exchange')),
  from_assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  to_user_id         INTEGER NOT NULL REFERENCES users(id),
  to_assignment_id   INTEGER REFERENCES assignments(id),
  requester_id       INTEGER NOT NULL REFERENCES users(id),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  message            TEXT,
  decided_at         TEXT,
  applied_at         TEXT,
  created_at         TEXT NOT NULL,
  -- exchange 必须有目标 assignment；transfer 不需要
  CHECK (
    (type = 'transfer' AND to_assignment_id IS NULL)
    OR (type = 'exchange' AND to_assignment_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_swaps_period ON swap_requests(period_id, status);
CREATE INDEX IF NOT EXISTS idx_swaps_requester ON swap_requests(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_swaps_to_user ON swap_requests(to_user_id, status);

-- 参与者：逐个确认的核心。发起人自身直接 approved，接收人 pending
CREATE TABLE IF NOT EXISTS swap_participants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    INTEGER NOT NULL REFERENCES swap_requests(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('requester', 'receiver')),
  seq        INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_at TEXT,
  UNIQUE (swap_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_swap_participants_user ON swap_participants(user_id, status);

-- ---------------------------------------------------------------------------
-- 8. 操作日志
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   INTEGER,
  period_id   INTEGER,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  detail_json TEXT,
  request_id  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_period ON audit_logs(period_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at);

-- 联机游乐场：身份和任务票仅存服务器，响应按当前玩家裁剪。
CREATE TABLE IF NOT EXISTS playground_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  host_id INTEGER NOT NULL REFERENCES users(id),
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avalon_updated ON playground_rooms(updated_at);
CREATE TABLE IF NOT EXISTS playground_members (
  room_id INTEGER NOT NULL REFERENCES playground_rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  PRIMARY KEY (room_id,user_id)
);
CREATE TABLE IF NOT EXISTS playground_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  game TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  summary_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playground_record_members (
  record_id INTEGER NOT NULL REFERENCES playground_records(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (record_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_playground_record_user ON playground_record_members(user_id,record_id);

-- 游戏收获独立于可删除的游戏记录，防重复发放与删除后重新领取。
CREATE TABLE IF NOT EXISTS playground_harvest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  game TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_playground_harvest_user ON playground_harvest(user_id,id DESC);
CREATE TABLE IF NOT EXISTS playground_lessons (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','completed','abandoned')),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_playground_lesson_active ON playground_lessons(user_id,game) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_playground_lessons_completed ON playground_lessons(user_id,game,updated_at) WHERE status='completed';
CREATE TABLE IF NOT EXISTS playground_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  level_id TEXT NOT NULL,
  best_score INTEGER NOT NULL,
  last_score INTEGER NOT NULL,
  max_score INTEGER NOT NULL,
  cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0,1)),
  attempts INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,game,level_id)
);

-- 许愿兑换记录独立保留；话题删除后仍保留消费和请求去重。
CREATE TABLE IF NOT EXISTS playground_wishes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  cost INTEGER NOT NULL DEFAULT 30 CHECK (cost IN (10, 30)),
  topic_id INTEGER UNIQUE REFERENCES discussion_topics(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_key)
);
CREATE INDEX IF NOT EXISTS idx_playground_wishes_user ON playground_wishes(user_id,created_at DESC);

-- 不依赖周期的日历安排；与周期生效排班共同展示。
CREATE TABLE IF NOT EXISTS calendar_works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_date TEXT NOT NULL,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  work_type_id INTEGER NOT NULL REFERENCES work_types(id),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(work_date,shift_id,work_type_id)
);
CREATE TABLE IF NOT EXISTS calendar_people (
  work_id INTEGER NOT NULL REFERENCES calendar_works(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  duty_role TEXT NOT NULL CHECK(duty_role IN ('member','primary','deputy')),
  PRIMARY KEY(work_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_people_user ON calendar_people(user_id,work_id);

CREATE TABLE IF NOT EXISTS exercise_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  weekly_goal INTEGER NOT NULL DEFAULT 3 CHECK (weekly_goal BETWEEN 1 AND 7),
  reminder_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reminder_enabled IN (0,1)),
  reminder_time TEXT NOT NULL DEFAULT '20:30',
  reminded_date TEXT
);
CREATE TABLE IF NOT EXISTS exercise_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  sport_name TEXT NOT NULL,
  is_custom INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0,1)),
  work_date TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  note TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (user_id,request_key)
);
CREATE INDEX IF NOT EXISTS idx_exercise_user_date ON exercise_records(user_id,work_date,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_exercise_public ON exercise_records(id DESC) WHERE visibility='public' AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS exercise_images (
  record_id INTEGER NOT NULL REFERENCES exercise_records(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
  mime_type TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (record_id,position)
);
CREATE TABLE IF NOT EXISTS exercise_likes (
  record_id INTEGER NOT NULL REFERENCES exercise_records(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (record_id,user_id)
);

CREATE TABLE IF NOT EXISTS exercise_body_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  weight REAL CHECK (weight BETWEEN 0.1 AND 1000),
  body_fat REAL CHECK (body_fat BETWEEN 0.1 AND 99.9),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (weight IS NOT NULL OR body_fat IS NOT NULL),
  UNIQUE (user_id,work_date)
);
