'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-password-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
const db = require('../src/db/db');
const { migrate, truncateAll } = require('../src/db/migrate');
const users = require('../src/repositories/userRepo');
const auth = require('../src/services/authService');
const { hashPasswordSync, verifyPasswordSync } = require('../src/utils/security');
let employee, admin, root;
const original = 'Original123';
test.beforeEach(() => {
  migrate(); truncateAll();
  [employee, admin, root] = ['employee', 'admin', 'super_admin'].map((role, i) => users.insertUser({ employeeNo: `USER${i}`, name: `人员${i}`, role, passwordHash: hashPasswordSync(original) }));
});
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
test('所有角色验证原密码后可自行改密，撤销本人全部会话，不影响他人，并记录无密码审计', () => {
  for (const id of [employee, admin, root]) {
    auth.issueSession(id); auth.issueSession(id);
    const other = id === employee ? admin : employee;
    auth.issueSession(other);
    const otherCount = db.pluck('SELECT COUNT(*) FROM sessions WHERE user_id=?', other);
    const newPassword = `NewPassword${id}`;
    auth.changePassword(id, { oldPassword: original, newPassword }, { requestId: 'self-password' });
    assert.equal(db.pluck('SELECT COUNT(*) FROM sessions WHERE user_id=?', id), 0);
    assert.equal(db.pluck('SELECT COUNT(*) FROM sessions WHERE user_id=?', other), otherCount);
    assert.ok(verifyPasswordSync(newPassword, users.findById(id).password_hash));
    assert.throws(() => auth.login({ employeeNo: users.findById(id).employee_no, password: original }), (e) => e.status === 401);
    assert.equal(auth.login({ employeeNo: users.findById(id).employee_no, password: newPassword }).user.id, id);
  }
  const logs = db.all("SELECT * FROM audit_logs WHERE action='AUTH_PASSWORD_CHANGE'");
  assert.deepEqual(logs.map((l) => l.actor_id), [employee, admin, root]);
  assert.ok(logs.every((l) => l.detail_json === null && l.entity_id === l.actor_id));
});
test('错误原密码、非法密码、相同新密码和停用账号均不改密码或会话', () => {
  auth.issueSession(employee);
  const before = users.findById(employee).password_hash;
  for (const [oldPassword, newPassword] of [['Wrong123', 'Updated123'], [original, '12345'], [original, 'x'.repeat(129)], [original, { value: 'Updated123' }], [original, original], [null, 'Updated123'], ['x'.repeat(129), 'Updated123']]) {
    assert.throws(() => auth.changePassword(employee, { oldPassword, newPassword }), (e) => e.status === 400);
    assert.equal(users.findById(employee).password_hash, before);
    assert.equal(db.pluck('SELECT COUNT(*) FROM sessions WHERE user_id=?', employee), 1);
  }
  users.updateUser(employee, { status: 'disabled' });
  assert.throws(() => auth.changePassword(employee, { oldPassword: original, newPassword: 'Updated123' }), (e) => e.status === 403);
  assert.equal(db.pluck("SELECT COUNT(*) FROM audit_logs WHERE action='AUTH_PASSWORD_CHANGE'"), 0);
});
test('更新密码和撤销会话处于同一事务，撤销失败时完整回滚', () => {
  auth.issueSession(employee);
  const before = users.findById(employee).password_hash;
  const revoke = users.deleteUserSessions;
  users.deleteUserSessions = () => { throw Error('模拟撤销失败'); };
  try { assert.throws(() => auth.changePassword(employee, { oldPassword: original, newPassword: 'Updated123' }), /模拟撤销失败/); }
  finally { users.deleteUserSessions = revoke; }
  assert.equal(users.findById(employee).password_hash, before);
  assert.equal(db.pluck('SELECT COUNT(*) FROM sessions WHERE user_id=?', employee), 1);
});
