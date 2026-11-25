'use strict';

const db = require('../db/db');
const { badRequest, forbidden, notFound, conflict } = require('../utils/errors');
const { requireString, requireEnum, requireArray, requireInt, requireBoolean } = require('../utils/validate');

const isAdmin = user => ['admin', 'super_admin'].includes(user.role);
const fields = `t.id,t.title,t.description,t.created_by AS createdBy,t.assignee_id AS assigneeId,
  c.display_name AS creatorName,a.display_name AS assigneeName,t.visibility,t.priority,t.due_at AS dueAt,
  t.tags_json AS tagsJson,t.repeat_kind AS repeatKind,t.completed_at AS completedAt,t.archived_at AS archivedAt,t.completion_note AS completionNote,
  t.created_at AS createdAt,t.updated_at AS updatedAt,r.remind_at AS remindAt,r.notified_at AS remindedAt`;
const joins = `FROM todos t JOIN users c ON c.id=t.created_by JOIN users a ON a.id=t.assignee_id
  LEFT JOIN todo_reminders r ON r.todo_id=t.id AND r.user_id=?`;
const visible = "(t.visibility='public' OR t.created_by=?)";
const relatedSql = '(t.created_by=? OR t.assignee_id=? OR EXISTS (SELECT 1 FROM todo_items i WHERE i.todo_id=t.id AND i.assignee_id=?))';
const order = 't.archived_at IS NOT NULL,t.completed_at IS NOT NULL,t.due_at IS NULL,t.due_at,t.priority=\'urgent\' DESC,t.created_at DESC,t.id DESC';

function instant(value, label) {
  if (value == null || value === '') return null;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw badRequest(`${label}格式无效`);
  if (time < Date.parse('2000-01-01') || time > Date.parse('2100-01-01')) throw badRequest(`${label}超出支持范围`);
  return value;
}

function raw(id) {
  const todo = db.get('SELECT * FROM todos WHERE id=?', id);
  if (!todo) throw notFound('待办不存在');
  return todo;
}

function readable(id, user) {
  const todo = raw(id);
  if (todo.visibility === 'private' && todo.created_by !== user.id) throw notFound('待办不存在');
  return todo;
}

function editable(id, user) {
  const todo = readable(id, user);
  if (todo.created_by !== user.id) throw forbidden('只有创建者可以修改或删除待办');
  return todo;
}

function related(todo, user) {
  if (todo.created_by !== user.id && !executionIds(todo).has(user.id)) throw forbidden('只能为与自己有关的待办设置提醒');
}

function executionIds(todo) {
  return new Set([todo.assignee_id, ...db.all('SELECT assignee_id FROM todo_items WHERE todo_id=? AND assignee_id IS NOT NULL', todo.id)
    .map(item => item.assignee_id)]);
}

function present(row, user) {
  const { tagsJson, ...todo } = row;
  const items = db.all(`SELECT i.id,i.title,i.done,i.assignee_id AS assignedTo,COALESCE(i.assignee_id,?) AS assigneeId,
    u.display_name AS assigneeName FROM todo_items i JOIN users u ON u.id=COALESCE(i.assignee_id,?)
    WHERE i.todo_id=? ORDER BY i.position,i.id`, todo.assigneeId, todo.assigneeId, todo.id)
    .map(({ assignedTo, ...item }) => ({ ...item, done: !!item.done, followAssignee: assignedTo == null, canComplete: !todo.archivedAt && item.assigneeId === user.id }));
  return { ...todo, tags: JSON.parse(tagsJson), canEdit: todo.createdBy === user.id,
    canComplete: !todo.archivedAt && todo.assigneeId === user.id,
    canArchive: todo.createdBy === user.id || todo.assigneeId === user.id,
    canRemind: !todo.archivedAt && (todo.createdBy === user.id || todo.assigneeId === user.id || items.some(item => item.canComplete)), items };
}

function get(id, user) {
  readable(id, user);
  return present(db.get(`SELECT ${fields} ${joins} WHERE t.id=?`, user.id, id), user);
}

function list(user, query = {}) {
  const scope = requireEnum(query.scope ?? 'mine', '范围', ['mine', 'public', 'private']);
  const status = requireEnum(query.status ?? 'pending', '状态', ['pending', 'overdue', 'completed', 'archived', 'all']);
  const page = requireInt(query.page ?? 1, '页码', { min: 1, max: 100000 });
  const keyword = requireString(query.keyword ?? '', '搜索词', { min: 0, max: 80 });
  const tag = requireString(query.tag ?? '', '标签', { min: 0, max: 20 });
  const params = [user.id];
  let where = visible;
  if (scope === 'mine') { where += ` AND ${relatedSql}`; params.push(user.id, user.id, user.id); }
  else if (scope === 'public') where += " AND t.visibility='public'";
  else where += " AND t.visibility='private'";
  if (status === 'archived') where += ' AND t.archived_at IS NOT NULL';
  else if (status !== 'all') where += ' AND t.archived_at IS NULL';
  if (status === 'pending' || status === 'overdue') where += ' AND t.completed_at IS NULL';
  if (status === 'completed') where += ' AND t.completed_at IS NOT NULL';
  if (status === 'overdue') { where += ' AND t.due_at<?'; params.push(new Date().toISOString()); }
  if (keyword) { where += ' AND (t.title LIKE ? OR t.description LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  if (tag) { where += ' AND EXISTS (SELECT 1 FROM json_each(t.tags_json) WHERE value=?)'; params.push(tag); }
  const total = db.pluck(`SELECT COUNT(*) FROM todos t WHERE ${where}`, params);
  const items = db.all(`SELECT ${fields} ${joins} WHERE ${where} ORDER BY ${order} LIMIT 30 OFFSET ?`,
    user.id, ...params, (page - 1) * 30).map(row => present(row, user));
  return { items, total, page, pageSize: 30 };
}

function recent(user) {
  const row = db.get(`SELECT ${fields} ${joins} WHERE ${visible} AND ${relatedSql}
    AND t.completed_at IS NULL AND t.archived_at IS NULL ORDER BY ${order} LIMIT 1`, user.id, user.id, user.id, user.id, user.id);
  return row ? present(row, user) : null;
}

function tags(user) {
  return db.all(`SELECT DISTINCT j.value AS tag FROM todos t,json_each(t.tags_json) j
    WHERE ${visible} ORDER BY j.value LIMIT 200`, user.id).map(row => row.tag);
}

function validate(body, user, previous) {
  const title = requireString(body.title, '标题', { max: 80 });
  const description = requireString(body.description ?? '', '描述', { min: 0, max: 4000 });
  const assigneeId = requireInt(body.assigneeId ?? user.id, '执行人', { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (assigneeId !== user.id && !isAdmin(user)) throw forbidden('只有管理员可以分配待办');
  const assignee = db.get("SELECT id FROM users WHERE id=? AND status='active' AND role<>'super_admin'", assigneeId);
  if (!assignee) throw badRequest('请选择启用的员工或管理员作为执行人');
  const visibility = requireEnum(body.visibility ?? 'public', '可见范围', ['public', 'private']);
  if (visibility === 'private' && assigneeId !== user.id) throw badRequest('分配给他人的待办须保持公开');
  const priority = requireEnum(body.priority ?? 'normal', '优先级', ['normal', 'urgent']);
  const dueAt = instant(body.dueAt, '截止时间');
  const repeatKind = requireEnum(body.repeatKind ?? 'none', '重复方式', ['none', 'weekly', 'monthly']);
  if (repeatKind !== 'none' && !dueAt) throw badRequest('重复待办需要设置截止时间');
  const tags = [...new Set(requireArray(body.tags ?? [], '标签', { max: 8 })
    .map(tag => requireString(tag, '标签', { max: 20 })))];
  const previousItems = new Map(db.all('SELECT id,done FROM todo_items WHERE todo_id=?', previous?.id ?? 0).map(item => [item.id, item.done]));
  const seen = new Set();
  const items = requireArray(body.items ?? [], '子任务', { max: 30 }).map(item => {
    const id = item?.id == null ? null : requireInt(item.id, '子任务编号', { min: 1 });
    if (id && (!previousItems.has(id) || seen.has(id))) throw badRequest('子任务已变化，请刷新后重试');
    seen.add(id);
    const assignedTo = item?.followAssignee || item?.assigneeId == null ? null : requireInt(item.assigneeId, '子任务执行人', { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (assignedTo != null) {
      if (assignedTo !== user.id && !isAdmin(user)) throw forbidden('只有管理员可以分配子任务给他人');
      if (!db.get("SELECT id FROM users WHERE id=? AND status='active' AND role<>'super_admin'", assignedTo)) throw badRequest('子任务执行人不可用');
    }
    if (visibility === 'private' && (assignedTo ?? assigneeId) !== user.id) throw badRequest('分配子任务给他人时，待办须保持公开');
    return { id, title: requireString(item?.title, '子任务内容', { max: 120 }), assigneeId: assignedTo, done: id ? previousItems.get(id) : 0 };
  });
  return { title, description, assigneeId, visibility, priority, dueAt, repeatKind, tags, items };
}

function putItems(id, items) {
  db.run('DELETE FROM todo_items WHERE todo_id=? AND id NOT IN (SELECT value FROM json_each(?))', id,
    JSON.stringify(items.filter(item => item.id).map(item => item.id)));
  items.forEach((item, index) => {
    if (item.id) db.run('UPDATE todo_items SET title=?,assignee_id=?,position=? WHERE id=? AND todo_id=?', item.title, item.assigneeId, index, item.id, id);
    else db.run('INSERT INTO todo_items (todo_id,title,assignee_id,position) VALUES (?,?,?,?)', id, item.title, item.assigneeId, index);
  });
}

function notice(todoId, userId, kind, now) {
  db.run('INSERT INTO todo_notices (todo_id,user_id,kind,created_at) VALUES (?,?,?,?)', todoId, userId, kind, now);
  const { queuePushEvent } = require('./reminderService');
  queuePushEvent(0, [userId], { title: '时禾 · 待办提醒',
    body: kind === 'assigned' ? '你收到一项待办，点击查看。' : '有一项待办需要处理，点击查看。',
    tag: `shihe-todo-${todoId}-${kind}`, path: `/?todo=${todoId}` }, 'todo');
}

function clearQueued(id, userId = null) {
  db.run(`DELETE FROM push_events WHERE push_kind='todo' AND json_extract(payload,'$.path')=?
    AND (? IS NULL OR user_id=?)`, `/?todo=${id}`, userId, userId);
}

function putReminder(id, userId, remindAt) {
  clearQueued(id, userId);
  db.run("DELETE FROM todo_notices WHERE todo_id=? AND user_id=? AND kind='reminder'", id, userId);
  if (!remindAt) db.run('DELETE FROM todo_reminders WHERE todo_id=? AND user_id=?', id, userId);
  else db.run(`INSERT INTO todo_reminders (todo_id,user_id,remind_at) VALUES (?,?,?)
    ON CONFLICT(todo_id,user_id) DO UPDATE SET remind_at=excluded.remind_at,notified_at=NULL`, id, userId, remindAt);
}

function reminderTime(value) {
  const time = instant(value, '提醒时间');
  if (time && time <= new Date().toISOString()) throw badRequest('提醒时间必须晚于当前时间');
  return time;
}

function create(body, user) {
  return db.tx(() => {
    const value = validate(body, user);
    const remindAt = reminderTime(body.remindAt);
    const now = new Date().toISOString();
    const { lastInsertRowid: id } = db.run(`INSERT INTO todos
      (title,description,created_by,assignee_id,visibility,priority,due_at,tags_json,repeat_kind,repeat_day,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, value.title, value.description, user.id, value.assigneeId, value.visibility,
    value.priority, value.dueAt, JSON.stringify(value.tags), value.repeatKind,
    value.dueAt ? new Date(Date.parse(value.dueAt) + 8 * 3600_000).getUTCDate() : null, now, now);
    putItems(id, value.items);
    if (remindAt) putReminder(id, value.assigneeId, remindAt);
    for (const userId of executionIds(raw(id))) if (userId !== user.id) notice(id, userId, 'assigned', now);
    return get(id, user);
  });
}

function stopRepeat(todo) {
  db.run("UPDATE todos SET repeat_kind='none' WHERE id=? OR repeat_group_id=?", todo.repeat_group_id ?? todo.id, todo.repeat_group_id ?? todo.id);
}

function update(id, body, user) {
  return db.tx(() => {
    const old = editable(id, user);
    if (old.archived_at) throw conflict('TODO_ARCHIVED', '请先恢复已归档的待办，再修改内容');
    const oldExecutionIds = executionIds(old);
    const value = validate(body, user, old);
    if (old.completed_at && value.items.some(item => !item.done)) throw conflict('TODO_COMPLETED', '请先恢复为未完成，再新增子任务');
    if (old.next_todo_id && value.repeatKind !== 'none' && (old.repeat_kind !== value.repeatKind || old.due_at !== value.dueAt)) {
      throw conflict('TODO_REPEAT_ADVANCED', '下一期待办已生成，请在最新一期修改重复时间');
    }
    if (value.repeatKind === 'none' && old.repeat_kind !== 'none') stopRepeat(old);
    const now = new Date().toISOString();
    db.run(`UPDATE todos SET title=?,description=?,assignee_id=?,visibility=?,priority=?,due_at=?,tags_json=?,
      repeat_kind=?,repeat_day=?,updated_at=? WHERE id=?`, value.title, value.description, value.assigneeId, value.visibility,
    value.priority, value.dueAt, JSON.stringify(value.tags), value.repeatKind,
    old.due_at === value.dueAt ? old.repeat_day : value.dueAt ? new Date(Date.parse(value.dueAt) + 8 * 3600_000).getUTCDate() : null, now, id);
    putItems(id, value.items);
    const newExecutionIds = executionIds(raw(id));
    const recipients = JSON.stringify([...newExecutionIds, user.id]);
    db.run('DELETE FROM todo_reminders WHERE todo_id=? AND user_id NOT IN (SELECT value FROM json_each(?))', id, recipients);
    db.run('DELETE FROM todo_notices WHERE todo_id=? AND user_id NOT IN (SELECT value FROM json_each(?))', id, recipients);
    for (const userId of oldExecutionIds) if (!newExecutionIds.has(userId) && userId !== user.id) clearQueued(id, userId);
    for (const userId of newExecutionIds) if (!oldExecutionIds.has(userId) && userId !== user.id) notice(id, userId, 'assigned', now);
    return get(id, user);
  });
}

function setReminder(id, value, user) {
  return db.tx(() => {
    const todo = readable(id, user);
    related(todo, user);
    if (todo.archived_at) throw conflict('TODO_ARCHIVED', '已归档待办不再提醒，请先恢复');
    if (todo.completed_at && value != null) throw badRequest('已完成的待办不需要提醒');
    putReminder(id, user.id, reminderTime(value));
    return get(id, user);
  });
}

function complete(id, body, user) {
  return db.tx(() => {
    const todo = readable(id, user);
    if (todo.assignee_id !== user.id) throw forbidden('只有执行人可以更新完成状态');
    if (todo.archived_at) throw conflict('TODO_ARCHIVED', '请先恢复已归档的待办');
    const done = requireBoolean(body.completed, '完成状态');
    const note = requireString(body.completionNote ?? '', '完成备注', { min: 0, max: 1000 });
    const now = new Date().toISOString();
    if (done && !todo.completed_at) {
      const remaining = db.pluck('SELECT COUNT(*) FROM todo_items WHERE todo_id=? AND done=0', id);
      if (remaining) throw conflict('TODO_ITEMS_PENDING', `还有 ${remaining} 项子任务未完成，请各执行人先完成子任务`);
      db.run('UPDATE todos SET completed_at=?,completion_note=?,updated_at=? WHERE id=?', now, note, now, id);
      clearQueued(id);
      db.run('UPDATE todo_notices SET read_at=? WHERE todo_id=? AND read_at IS NULL', now, id);
    } else if (!done && todo.completed_at) {
      db.run("UPDATE todos SET completed_at=NULL,completion_note='',updated_at=? WHERE id=?", now, id);
    }
    return get(id, user);
  });
}

function setItem(id, itemId, done, user) {
  return db.tx(() => {
    const todo = readable(id, user);
    if (todo.archived_at) throw conflict('TODO_ARCHIVED', '请先恢复已归档的待办');
    const item = db.get('SELECT assignee_id FROM todo_items WHERE id=? AND todo_id=?', itemId, id);
    if (!item) throw notFound('子任务不存在');
    if ((item.assignee_id ?? todo.assignee_id) !== user.id) throw forbidden('只能勾选自己负责的子任务');
    if (todo.completed_at) throw conflict('TODO_COMPLETED', '请先将待办恢复为未完成');
    requireBoolean(done, '子任务状态');
    if (!db.run('UPDATE todo_items SET done=? WHERE id=? AND todo_id=?', done, itemId, id).changes) throw notFound('子任务不存在');
    return get(id, user);
  });
}

function remove(id, user) {
  db.tx(() => {
    const todo = editable(id, user);
    stopRepeat(todo);
    clearQueued(id);
    db.run('DELETE FROM todos WHERE id=?', id);
  });
}

function archive(id, archived, user) {
  return db.tx(() => {
    requireBoolean(archived, '归档状态');
    const todo = readable(id, user);
    if (todo.created_by !== user.id && todo.assignee_id !== user.id) throw forbidden('只有创建者和主执行人可以归档或恢复');
    const now = new Date().toISOString();
    if (archived && !todo.archived_at) {
      if (todo.completed_at || !todo.due_at || todo.due_at >= now) throw badRequest('只有逾期未完成的待办可以归档');
      db.run('UPDATE todos SET archived_at=?,updated_at=? WHERE id=?', now, now, id);
      db.run('UPDATE todo_notices SET read_at=? WHERE todo_id=? AND read_at IS NULL', now, id);
      clearQueued(id);
    } else if (!archived && todo.archived_at) {
      db.run('DELETE FROM todo_reminders WHERE todo_id=?', id);
      db.run('UPDATE todos SET archived_at=NULL,updated_at=? WHERE id=?', now, id);
    }
    return get(id, user);
  });
}

function unread(user) {
  return db.all(`SELECT n.id,n.todo_id AS todoId,n.kind,n.created_at AS createdAt,t.title,c.display_name AS creatorName
    FROM todo_notices n JOIN todos t ON t.id=n.todo_id JOIN users c ON c.id=t.created_by
    WHERE n.user_id=? AND n.read_at IS NULL AND t.archived_at IS NULL AND ${visible} ORDER BY n.id DESC`, user.id, user.id);
}

function markRead(id, user) {
  readable(id, user);
  db.run('UPDATE todo_notices SET read_at=? WHERE todo_id=? AND user_id=? AND read_at IS NULL', new Date().toISOString(), id, user.id);
}

function nextDue(todo, now) {
  const local = new Date(Date.parse(todo.due_at) + 8 * 3600_000);
  do {
    if (todo.repeat_kind === 'weekly') local.setUTCDate(local.getUTCDate() + 7);
    else {
      local.setUTCDate(1);
      local.setUTCMonth(local.getUTCMonth() + 1);
      const last = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
      local.setUTCDate(Math.min(todo.repeat_day, last));
    }
  } while (local.getTime() - 8 * 3600_000 <= Date.parse(now));
  return new Date(local.getTime() - 8 * 3600_000).toISOString();
}

function processDueTodos(now = new Date().toISOString()) {
  db.tx(() => {
    const repeats = db.all(`SELECT t.* FROM todos t JOIN users c ON c.id=t.created_by JOIN users a ON a.id=t.assignee_id
      WHERE t.repeat_kind<>'none' AND t.next_todo_id IS NULL AND t.due_at<=? AND c.status='active' AND a.status='active'`, now);
    for (const old of repeats) {
      const due = nextDue(old, now);
      const { lastInsertRowid: id } = db.run(`INSERT INTO todos
        (title,description,created_by,assignee_id,visibility,priority,due_at,tags_json,repeat_kind,repeat_day,repeat_group_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, old.title, old.description, old.created_by, old.assignee_id, old.visibility,
      old.priority, due, old.tags_json, old.repeat_kind, old.repeat_day, old.repeat_group_id ?? old.id, now, now);
      db.run('INSERT INTO todo_items (todo_id,title,assignee_id,position) SELECT ?,title,assignee_id,position FROM todo_items WHERE todo_id=?', id, old.id);
      db.run('UPDATE todos SET next_todo_id=? WHERE id=?', id, old.id);
      for (const reminder of db.all('SELECT * FROM todo_reminders WHERE todo_id=?', old.id)) {
        const next = new Date(Math.max(Date.parse(now), Date.parse(due) - (Date.parse(old.due_at) - Date.parse(reminder.remind_at)))).toISOString();
        putReminder(id, reminder.user_id, next);
      }
      for (const userId of executionIds(raw(id))) if (userId !== old.created_by) notice(id, userId, 'assigned', now);
    }
    const due = db.all(`SELECT r.* FROM todo_reminders r JOIN todos t ON t.id=r.todo_id JOIN users u ON u.id=r.user_id
      WHERE r.notified_at IS NULL AND r.remind_at<=? AND t.completed_at IS NULL AND t.archived_at IS NULL AND u.status='active'
        AND (r.user_id=t.created_by OR r.user_id=t.assignee_id OR EXISTS (SELECT 1 FROM todo_items i WHERE i.todo_id=t.id AND i.assignee_id=r.user_id))
        AND (t.visibility='public' OR t.created_by=r.user_id)`, now);
    for (const reminder of due) {
      notice(reminder.todo_id, reminder.user_id, 'reminder', now);
      db.run('UPDATE todo_reminders SET notified_at=? WHERE todo_id=? AND user_id=?', now, reminder.todo_id, reminder.user_id);
    }
  });
}

module.exports = { get, list, recent, tags, create, update, setReminder, complete, setItem, remove, archive, unread, markRead, processDueTodos };
