'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 在临时目录模拟外部命令，验证部署流程，不接触真实 Docker 或项目数据。
function deploy(t, envFile, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamshift-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'deploy/certs/live/teamshift'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(path.join(__dirname, 'deploy.sh'), path.join(root, 'deploy/deploy.sh'));
  fs.writeFileSync(path.join(root, '.env.production'), envFile);
  fs.writeFileSync(path.join(root, 'deploy/certs/live/teamshift/fullchain.pem'), 'existing certificate');
  const mocks = {
    docker: `
printf 'docker %s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *' up -d --build') exit "$MOCK_BUILD_EXIT" ;;
  inspect*) echo healthy ;;
  *' exec -T backend node -e '*) echo 1 ;;
  *) echo mock-docker ;;
esac`,
    curl: `
printf 'curl %s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *api.ipify.org*|*ifconfig.me*) echo 203.0.113.10 ;;
  */api/health) printf '%s\\n' "$MOCK_HEALTH" ;;
  *) exit "$MOCK_PAGE_EXIT" ;;
esac`,
    getent: 'printf "getent %s\\n" "$*" >> "$MOCK_LOG"; echo "203.0.113.10 shift.test"',
    sleep: 'exit 0',
    ss: 'exit 0',
    openssl: 'echo notAfter=tomorrow',
  };
  for (const [name, body] of Object.entries(mocks)) {
    fs.writeFileSync(path.join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const result = spawnSync('bash', [path.join(root, 'deploy/deploy.sh')], {
    env: { PATH: `${root}/bin:${process.env.PATH}`, MOCK_LOG: `${root}/commands`, MOCK_HEALTH: '{"data":{"ok":true}}', MOCK_BUILD_EXIT: '0', MOCK_PAGE_EXIT: '0', ...overrides },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { ...result, output: result.stdout + result.stderr, commands: fs.readFileSync(`${root}/commands`, 'utf8') };
}

test('IP 部署不要求域名、邮箱、DNS 或证书，检查本机 API 和首页', (t) => {
  const r = deploy(t, 'SERVER_IP=203.0.113.10\n');
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /http:\/\/203\.0\.113\.10\//);
  assert.match(r.commands, /--env-file .env.production up -d --build/);
  assert.match(r.commands, /http:\/\/127\.0\.0\.1\/api\/health/);
  assert.match(r.commands, /http:\/\/127\.0\.0\.1\/\n/);
  assert.doesNotMatch(r.commands, /getent|certbot|api.ipify|ifconfig.me|https:\/\//);
});

test('示例环境变量原样可部署，无需填写 SERVER_IP', (t) => {
  const r = deploy(t, fs.readFileSync(path.join(__dirname, '../.env.production.example'), 'utf8'));
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /部署完成/);
});

test('HTTPS 保留域名和邮箱校验', (t) => {
  for (const config of ['DEPLOY_SCHEME=https\n', 'DEPLOY_SCHEME=https\nDOMAIN=shift.test\n']) {
    const r = deploy(t, config);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /DOMAIN 未填写|CERT_EMAIL 未填写/);
    assert.doesNotMatch(r.commands, / up -d/);
  }
});

test('HTTPS 复用证书，并通过本机 Nginx 校验证书和页面', (t) => {
  const r = deploy(t, 'DEPLOY_SCHEME=https\nDOMAIN=shift.test\nCERT_EMAIL=admin@shift.test\n');
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /https:\/\/shift.test\//);
  assert.match(r.commands, /--resolve shift.test:443:127.0.0.1 https:\/\/shift.test\/api\/health/);
  assert.match(r.commands, /-f docker-compose.https.yml up -d --build/);
  assert.doesNotMatch(r.commands, /--insecure| -k /);
});

test('无效协议在启动服务前失败', (t) => {
  const r = deploy(t, 'DEPLOY_SCHEME=ftp\n');
  assert.equal(r.status, 1, r.output);
  assert.doesNotMatch(r.commands, / up -d/);
});

test('构建、API 或首页失败时不报告部署完成', (t) => {
  for (const overrides of [{ MOCK_BUILD_EXIT: '1' }, { MOCK_HEALTH: '{"data":{"ok":false}}' }, { MOCK_PAGE_EXIT: '22' }]) {
    const r = deploy(t, 'DEPLOY_SCHEME=http\n', overrides);
    assert.equal(r.status, 1, r.output);
    assert.doesNotMatch(r.output, /部署完成/);
  }
});
