'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.RATE_LIMIT_ENABLED = '0';
const db = require('../src/db/db');
const { migrate } = require('../src/db/migrate');
const { config } = require('../src/config');
const { createApp } = require('../src/app');
const users = require('../src/repositories/userRepo');
const auth = require('../src/services/authService');
const { hashPasswordSync, verifyPasswordSync, passwordNeedsRehash } = require('../src/utils/security');

test('旧密码成功登录后升级哈希，失败或停用账号不会修改密码', () => {
  db.open(':memory:');
  migrate();
  try {
    const password = 'ExistingPassword2026';
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    const legacy = `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
    const id = users.insertUser({ employeeNo: 'legacy', name: '旧账号', passwordHash: legacy });
    assert.equal(verifyPasswordSync(password, legacy), true);
    assert.equal(passwordNeedsRehash(legacy), true);
    assert.throws(() => auth.login({ employeeNo: 'legacy', password: 'WrongPassword' }));
    assert.equal(users.findById(id).password_hash, legacy);
    users.updateUser(id, { status: 'disabled' });
    assert.throws(() => auth.login({ employeeNo: 'legacy', password }), error => error.status === 403);
    assert.equal(users.findById(id).password_hash, legacy);
    users.updateUser(id, { status: 'active' });
    assert.equal(auth.login({ employeeNo: 'legacy', password }).user.id, id);
    const upgraded = users.findById(id).password_hash;
    assert.match(upgraded, /^scrypt\$16384\$8\$5\$/);
    assert.equal(verifyPasswordSync(password, upgraded), true);
    assert.equal(passwordNeedsRehash(upgraded), false);
    assert.notEqual(hashPasswordSync(password), upgraded);
    auth.login({ employeeNo: 'legacy', password });
    assert.equal(users.findById(id).password_hash, upgraded);
  } finally { db.close(); }
});

test('仅请求头 token 可鉴权，查询参数不会出现在访问日志或 404 响应中', async t => {
  db.open(':memory:');
  migrate();
  const id = users.insertUser({ employeeNo: 'member', name: '成员', passwordHash: 'fixture' });
  const token = auth.issueSession(id).token;
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const server = createApp().listen(0, '127.0.0.1');
  t.after(() => { server.close(); db.close(); });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const query = `?token=${token}&password=security-test-password`;
  assert.equal((await fetch(base + '/api/auth/me' + query)).status, 401);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { authorization: `Bearer ${token}` } })).status, 200);
  const missing = await fetch(base + '/api/missing' + query);
  assert.equal(missing.status, 404);
  const body = await missing.text();
  assert.equal(body.includes(token), false);
  assert.equal(body.includes('security-test-password'), false);
  assert.ok(logs.some(line => line.includes('/api/auth/me 401')));
  assert.equal(logs.join('\n').includes(token), false);
  assert.equal(logs.join('\n').includes('security-test-password'), false);
});

test('HTTPS 保护拒绝明文登录和不可信代理头，可信 TLS 代理与健康检查可用', async t => {
  db.open(':memory:');
  migrate();
  const previous = { requireHttps: config.requireHttps, trustProxy: config.trustProxy };
  config.requireHttps = true;
  config.trustProxy = false;
  const direct = createApp().listen(0, '127.0.0.1');
  config.trustProxy = true;
  const proxied = createApp().listen(0, '127.0.0.1');
  t.after(() => { direct.close(); proxied.close(); db.close(); Object.assign(config, previous); });
  await Promise.all([once(direct, 'listening'), once(proxied, 'listening')]);
  const post = (server, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
  });
  assert.equal((await post(direct)).status, 426);
  assert.equal((await post(direct, { 'x-forwarded-proto': 'https' })).status, 426);
  assert.equal((await post(proxied)).status, 426);
  assert.equal((await post(proxied, { 'x-forwarded-proto': 'https' })).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${direct.address().port}/api/health`)).status, 200);
});

test('生产环境禁止演示初始化，在打开数据库前拒绝 --reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shihe-production-seed-'));
  try {
    const dbFile = join(dir, 'must-not-exist.db');
    const result = spawnSync(process.execPath, [join(__dirname, '../scripts/seed.js'), '--reset'], {
      env: { ...process.env, NODE_ENV: 'production', DB_FILE: dbFile }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /生产环境禁止/);
    assert.equal(existsSync(dbFile), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
