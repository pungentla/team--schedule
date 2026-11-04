'use strict';

/**
 * 小程序接口联调验收 —— 按小程序真实调用序列逐个打通接口。
 *
 * 与 verify-e2e.js 的分工：
 *   verify-e2e.js        → 验证业务闭环（排班、换班状态机、审计）
 *   verify-miniprogram.js → 验证「小程序的每个页面依赖的接口都能通」
 *
 * 用法：npm run verify:mp   （需后端已启动）
 */
const http = require('node:http');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const u = new URL(BASE);
let pass = 0, fail = 0;
const fails = [];

function req(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    if (token) headers.authorization = `Bearer ${token}`;
    if (process.env.VERIFY_KEY) headers['x-verify-key'] = process.env.VERIFY_KEY;
    const r = http.request({ hostname: u.hostname, port: u.port, path, method, headers, timeout: 10000 }, (res) => {
      const cs = []; res.on('data', c => cs.push(c));
      res.on('end', () => {
        const t = Buffer.concat(cs).toString();
        let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
        resolve({ status: res.statusCode, data: j && j.data, error: j && j.error });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}  ${detail}`); }
}

(async () => {
  console.log('\n【登录页】');
  const h = await req('GET', '/api/health');
  check('health 可用（登录页服务器探测依赖）', h.status === 200 && h.data.ok);
  check('返回 lanUrls（真机自动发现依赖）', Array.isArray(h.data.lanUrls) && h.data.lanUrls.length > 0, JSON.stringify(h.data.lanUrls));

  const login = await req('POST', '/api/auth/login', { body: { employeeNo: 'admin', password: '123456' } });
  check('登录成功', login.status === 200 && !!login.data.token);
  const T = login.data.token;

  console.log('\n【首页 home】');
  const cur = await req('GET', '/api/periods/current', { token: T });
  check('当前周期', cur.status === 200 && !!cur.data.id, `id=${cur.data && cur.data.id} ${cur.data && cur.data.status}`);
  const dash = await req('GET', '/api/schedule/dashboard', { token: T });
  check('管理总览', dash.status === 200 && !!dash.data.currentPeriod);
  const mine = await req('GET', '/api/schedule/mine', { token: T });
  check('我的排班', mine.status === 200 && Array.isArray(mine.data));
  const upcoming = await req('GET', '/api/schedule/mine?upcoming=1', { token: T });
  check('我的排班（未来）', upcoming.status === 200 && Array.isArray(upcoming.data));
  const pc = await req('GET', '/api/swaps/pending-count', { token: T });
  check('待确认换班数', pc.status === 200 && typeof pc.data.count === 'number');

  console.log('\n【排班页 schedule】');
  const sch = await req('GET', `/api/schedule/periods/${cur.data.id}`, { token: T });
  check('排班矩阵', sch.status === 200 && Array.isArray(sch.data.matrix), `${sch.data && sch.data.matrix.length} 天`);

  console.log('\n【报名页 enroll】');
  const ctx = await req('GET', `/api/enrollments/context/${cur.data.id}`, { token: T });
  check('报名上下文', ctx.status === 200 && !!ctx.data);

  console.log('\n【换班页 swap】');
  const mineSwaps = await req('GET', '/api/swaps?scope=mine', { token: T });
  check('我发起的换班', mineSwaps.status === 200 && Array.isArray(mineSwaps.data));
  const inbox = await req('GET', '/api/swaps?scope=inbox', { token: T });
  check('待我确认的换班', inbox.status === 200 && Array.isArray(inbox.data));
  const firstAssign = sch.data.assignments[0];
  if (firstAssign) {
    const cand = await req('GET', `/api/swaps/candidates/${firstAssign.id}`, { token: T });
    check('换班候选人', cand.status === 200 && Array.isArray(cand.data.candidates), `${cand.data && cand.data.candidates.length} 人`);
    check('候选人含班次明细（换班页展示依赖）',
      cand.data.candidates[0] && Array.isArray(cand.data.candidates[0].theirAssignments));
  }

  console.log('\n【我的页 my】');
  const statsMe = await req('GET', '/api/stats/me', { token: T });
  check('个人工作分布', statsMe.status === 200 && !!statsMe.data);

  console.log('\n【管理后台】');
  const wt = await req('GET', '/api/work-types', { token: T });
  check('工作类型列表', wt.status === 200 && Array.isArray(wt.data));
  const sh = await req('GET', '/api/shifts', { token: T });
  check('班次列表', sh.status === 200 && Array.isArray(sh.data));
  const users = await req('GET', '/api/admin/users', { token: T });
  check('员工列表', users.status === 200 && Array.isArray(users.data));
  const inv = await req('GET', '/api/admin/invites', { token: T });
  check('邀请码列表', inv.status === 200 && Array.isArray(inv.data));
  const audit = await req('GET', '/api/admin/audit-logs?page=1&pageSize=30', { token: T });
  check('审计日志', audit.status === 200 && Array.isArray(audit.data.items));
  const rq = await req('GET', `/api/periods/${cur.data.id}/requirements`, { token: T });
  check('需求矩阵', rq.status === 200 && !!rq.data.totalNeeded, `totalNeeded=${rq.data && rq.data.totalNeeded}`);

  console.log('\n【员工权限边界】');
  const emp = await req('POST', '/api/auth/login', { body: { employeeNo: 'emp005', password: '123456' } });
  const ET = emp.data.token;
  const empDash = await req('GET', '/api/schedule/dashboard', { token: ET });
  check('员工访问管理接口被拒 403', empDash.status === 403);
  const empSch = await req('GET', `/api/schedule/periods/${cur.data.id}`, { token: ET });
  check('员工只能看到已发布版本', empSch.data.run && empSch.data.run.status === 'published');
  const masked = empSch.data.assignments[0] && empSch.data.assignments[0].employeeNo;
  check('员工视角工号脱敏', typeof masked === 'string' && masked.includes('*'), masked);

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  if (fail) { console.log('失败项：', fails.join('、')); process.exit(1); }
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
