'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-accounts-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
const db = require('../src/db/db');
const { migrate, truncateAll } = require('../src/db/migrate');
const users = require('../src/repositories/userRepo');
const accounts = require('../src/services/accountService');
const auth = require('../src/services/authService');
const { requireAdmin } = require('../src/middleware/auth');
const { hashPasswordSync, hashToken } = require('../src/utils/security');
let superUser, admin, employee;
const ctx = (u) => ({ user: users.publicUser(users.findById(u)), requestId: 'accounts-test' });
test.beforeEach(() => {
  migrate(); truncateAll();
  [superUser, admin, employee] = ['super_admin','admin','employee'].map((role) => users.insertUser({ employeeNo: role, name: role, role, passwordHash: hashPasswordSync('test1234') }));
});
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('普通管理员只能新建、修改和重置员工，不能提权或修改管理员及超级管理员', () => {
  const created = accounts.create({ employeeNo: 'NEW_E', name: '新员工', password: 'abc12345' }, ctx(admin));
  assert.equal(created.role, 'employee');
  assert.equal(created.passwordHash, undefined);
  accounts.update(created.id, { employeeNo: 'changed_E', name: '新名字' }, ctx(admin));
  assert.equal(auth.login({ employeeNo: 'CHANGED_E', password: 'abc12345' }).user.name, '新名字');
  accounts.resetPassword(created.id, 'pass5678', ctx(admin));
  assert.throws(() => auth.login({ employeeNo: 'changed_E', password: 'abc12345' }), (e) => e.status === 401);
  assert.equal(auth.login({ employeeNo: 'changed_E', password: 'pass5678' }).user.id, created.id);
  for (const target of [admin, superUser]) {
    assert.throws(() => accounts.update(target, { name: '越权' }, ctx(admin)), (e) => e.status === 403);
    assert.throws(() => accounts.resetPassword(target, 'bad12345', ctx(admin)), (e) => e.status === 403);
  }
  assert.throws(() => accounts.update(employee, { role: 'admin' }, ctx(admin)), (e) => e.status === 403);
  assert.throws(() => accounts.create({ employeeNo: 'evil', name: '越权', password: 'bad12345', role: 'admin' }, ctx(admin)), (e) => e.status === 403);
});
test('超级管理员可配置管理员和员工，权限变更、账号变更及重置密码吊销会话', () => {
  const session = auth.login({ employeeNo: 'employee', password: 'test1234' });
  accounts.update(employee, { role: 'admin' }, ctx(superUser));
  assert.equal(db.pluck('SELECT COUNT(*) FROM sessions WHERE token_hash=?', hashToken(session.token)), 0);
  const manager = accounts.create({ employeeNo: 'manager2', name: '管理员2', password: 'test5678', role: 'admin' }, ctx(superUser));
  assert.equal(manager.role, 'admin');
  accounts.resetPassword(admin, 'new12345', ctx(superUser));
  assert.equal(auth.login({ employeeNo: 'admin', password: 'new12345' }).user.role, 'admin');
  accounts.update(manager.id, { status: 'disabled' }, ctx(superUser));
  assert.throws(() => auth.login({ employeeNo: 'manager2', password: 'test5678' }), (e) => e.status === 403);
  assert.throws(() => accounts.update(superUser, { role: 'employee' }, ctx(superUser)), /不能降级/);
  assert.throws(() => accounts.update(superUser, { status: 'disabled' }, ctx(superUser)), /不能降级/);
});
test('账号大小写唯一、输入校验、员工越权和审计不记录密码', () => {
  assert.throws(() => accounts.create({ employeeNo: 'EMPLOYEE', name: '重名', password: 'test1234' }, ctx(admin)), (e) => e.code === 'EMPLOYEE_NO_TAKEN');
  assert.throws(() => accounts.update(employee, { employeeNo: 'admin' }, ctx(admin)), (e) => e.code === 'EMPLOYEE_NO_TAKEN');
  assert.throws(() => accounts.create({ employeeNo: 'bad space', name: '坏账号', password: 'test1234' }, ctx(admin)), (e) => e.status === 400);
  assert.throws(() => accounts.resetPassword(employee, '123', ctx(admin)), (e) => e.status === 400);
  assert.throws(() => accounts.resetPassword(admin, 'test5678', ctx(employee)), (e) => e.status === 403);
  accounts.resetPassword(employee, 'private12345', ctx(admin));
  const logs = db.all('SELECT detail_json FROM audit_logs').map((x) => x.detail_json).join('');
  assert.ok(!logs.includes('private12345') && !logs.includes('password_hash'));
  let denied;
  requireAdmin({ user: { role: 'super_admin' } }, {}, (err) => { denied = err; });
  assert.equal(denied, undefined);
});
test('旧版本最早启用管理员自动升级超级管理员，重复迁移不改变权限', () => {
  db.run('DELETE FROM sessions'); db.run('DELETE FROM audit_logs'); db.run('DELETE FROM users');
  const first = users.insertUser({ employeeNo: 'old_admin', name: '原管理员', role: 'admin', passwordHash: 'fixture' });
  const second = users.insertUser({ employeeNo: 'old_admin2', name: '原管理员2', role: 'admin', passwordHash: 'fixture' });
  db.exec('PRAGMA user_version=4'); migrate();
  assert.equal(users.findById(first).role, 'super_admin');
  assert.equal(users.findById(second).role, 'admin');
  migrate(); assert.equal(users.findById(second).role, 'admin');
});
