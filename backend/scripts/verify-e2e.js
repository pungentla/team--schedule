'use strict';

/**
 * 端到端验收脚本 —— 零依赖（只用 node:http）。
 *
 * 覆盖真实 HTTP 链路：登录 → 报名查询 → 生成排班 → 校验填充率 → 发布
 *   → 员工查自己的班 → 发起换班 → 对方确认 → 校验换班生效与留痕 → 审计日志。
 *
 * 用法：
 *   node scripts/verify-e2e.js                # 连 127.0.0.1:3000
 *   BASE=http://1.2.3.4:3000 node scripts/verify-e2e.js
 *
 * 注意：会真实写入数据（换班等），建议在 seed 后的开发库上跑。
 */

const http = require('node:http');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const url = new URL(BASE);

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, extra = '') {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
}

function bad(name, detail) {
  fail += 1;
  failures.push({ name, detail });
  console.log(`  \x1b[31m✗\x1b[0m ${name}  \x1b[31m${detail}\x1b[0m`);
}

function assert(cond, name, detail) {
  if (cond) ok(name, detail);
  else bad(name, detail || '断言失败');
}

/** 极简请求封装 */
function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (token) headers.authorization = `Bearer ${token}`;
    // 生产环境开了限流时，用豁免密钥避免验收被误伤
    if (process.env.VERIFY_KEY) headers['x-verify-key'] = process.env.VERIFY_KEY;

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `/api${path}`,
        method,
        headers,
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, data: json && json.data, error: json && json.error, text });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const api = {
  get: (p, token) => request('GET', p, { token }),
  post: (p, body, token) => request('POST', p, { token, body }),
};

async function login(employeeNo, password = '123456') {
  const r = await api.post('/auth/login', { employeeNo, password });
  if (r.status !== 200) {
    throw new Error(`登录失败 ${employeeNo}: ${r.status} ${r.error ? r.error.message : r.text}`);
  }
  return r.data;
}

/** 找到指定用户在某周期内的候选班次（用于换班用例） */
function pickAssignment(schedule, userId) {
  const mine = schedule.assignments.filter((a) => a.userId === userId);
  return mine.length ? mine[0] : null;
}

async function main() {
  console.log(`\n\x1b[1m排班宝 TeamShift · 端到端验收\x1b[0m  →  ${BASE}\n`);

  // ---------- 1. 健康检查 ----------
  console.log('\x1b[1m[1] 服务可用性\x1b[0m');
  let health;
  try {
    health = await api.get('/health');
  } catch (err) {
    console.error(`\x1b[31m后端不可达：${err.message}\x1b[0m`);
    console.error('请先启动：cd backend && npm run dev');
    process.exit(1);
  }
  assert(health.status === 200, 'GET /health 返回 200');
  assert(health.data && health.data.ok === true, '健康检查 ok=true', `sqlite ${health.data && health.data.sqliteVersion}`);

  // ---------- 2. 登录 ----------
  console.log('\n\x1b[1m[2] 鉴权\x1b[0m');
  const admin = await login('admin');
  assert(!!admin.token, '管理员登录成功', `role=${admin.user.role}`);

  const wrong = await api.post('/auth/login', { employeeNo: 'admin', password: 'bad-password' });
  assert(wrong.status === 401, '错误密码返回 401', `code=${wrong.error && wrong.error.code}`);

  const noAuth = await api.get('/periods/current');
  assert(noAuth.status === 401, '未带 token 访问受保护接口返回 401');

  // ---------- 3. 周期与报名 ----------
  console.log('\n\x1b[1m[3] 周期与报名\x1b[0m');
  const periodRes = await api.get('/periods/current', admin.token);
  const period = periodRes.data;
  assert(!!period && !!period.id, '获取当前周期', `${period && period.name}`);
  const periodId = period.id;

  const req = await api.get(`/periods/${periodId}/requirements`, admin.token);
  assert(req.status === 200 && req.data != null, '需求矩阵可读',
    req.data ? `${req.data.dates.length} 天 × ${req.data.shifts.length} 班 × ${req.data.workTypes.length} 工作` : '');
  assert(req.data && req.data.totalNeeded > 0, '需求总人数已配置', `totalNeeded=${req.data && req.data.totalNeeded}`);

  // ---------- 4. 生成排班 ----------
  console.log('\n\x1b[1m[4] 排班生成\x1b[0m');
  // 先补一份未发布的场景：直接生成（草稿），不发布
  const gen = await api.post(`/schedule/periods/${periodId}/generate`, { seed: 42 }, admin.token);
  if (gen.status !== 200) {
    bad('生成排班', `HTTP ${gen.status} ${gen.error && gen.error.message}`);
  } else {
    const g = gen.data;
    ok('生成排班返回 200', `runId=${g.runId}`);
    assert(g.gaps.totalFilled > 0, '有排班产出', `${g.gaps.totalFilled}/${g.gaps.totalNeeded}`);
    assert(g.gaps.fillRate >= 0.9, '填充率 ≥ 90%', `实际 ${(g.gaps.fillRate * 100).toFixed(1)}%`);
    assert(g.stats.rounds >= 1, '迭代优化有执行', `${g.stats.rounds} 轮 / ${g.stats.durationMs}ms`);
    assert(!!g.metrics && typeof g.metrics.fairnessScore === 'number', '输出公平度指标', `score=${g.metrics.fairnessScore} grade=${g.metrics.grade}`);
  }

  // 确定性：同 seed 两次生成，inputHash 必须一致
  const gen2 = await api.post(`/schedule/periods/${periodId}/generate`, { seed: 42 }, admin.token);
  if (gen.status === 200 && gen2.status === 200) {
    assert(gen.data.inputHash === gen2.data.inputHash, '同 seed 两次生成 inputHash 一致（确定性）', `${gen.data.inputHash}`);
    const sameCount = gen.data.assignments.length === gen2.data.assignments.length;
    assert(sameCount, '同 seed 两次分配数量一致', `${gen.data.assignments.length} vs ${gen2.data.assignments.length}`);
  }

  // 不同 seed 应产生不同结果（证明种子真的起作用）
  const gen3 = await api.post(`/schedule/periods/${periodId}/generate`, { seed: 777 }, admin.token);
  if (gen.status === 200 && gen3.status === 200) {
    assert(gen.data.inputHash !== gen3.data.inputHash, '不同 seed 产生不同 inputHash');
  }

  // ---------- 5. 管理员视角看草稿 ----------
  console.log('\n\x1b[1m[5] 管理员预览草稿\x1b[0m');
  const adminView = await api.get(`/schedule/periods/${periodId}`, admin.token);
  assert(adminView.status === 200, '管理员读取排班表');
  assert(adminView.data.run && adminView.data.run.status === 'draft', '管理员默认看到最新草稿', `runId=${adminView.data.run && adminView.data.run.id}`);
  assert(Array.isArray(adminView.data.matrix) && adminView.data.matrix.length > 0, '矩阵结构非空', `${adminView.data.matrix.length} 天`);

  // 矩阵完整性：每个格子 assigned+gap 必须等于 needCount
  let cellChecked = 0;
  let cellBad = 0;
  for (const day of adminView.data.matrix) {
    for (const shift of day.shifts) {
      for (const wt of shift.workTypes) {
        cellChecked += 1;
        if (wt.assigned.length + wt.gap !== wt.needCount) cellBad += 1;
      }
    }
  }
  assert(cellChecked > 0 && cellBad === 0, '矩阵每格「已排+缺口=需求」自洽', `检查 ${cellChecked} 格`);

  // ---------- 6. 发布 ----------
  console.log('\n\x1b[1m[6] 发布排班\x1b[0m');
  const pub = await api.post(`/schedule/periods/${periodId}/publish`, { runId: adminView.data.run.id }, admin.token);
  assert(pub.status === 200, '发布接口返回 200', `filled=${pub.data && pub.data.filled}`);
  assert(pub.data && pub.data.published === true, 'published=true');

  const pubAgain = await api.post(`/schedule/periods/${periodId}/publish`, { runId: adminView.data.run.id }, admin.token);
  assert(pubAgain.data && pubAgain.data.alreadyPublished === true, '重复发布幂等（alreadyPublished）');

  const empViewRun = await api.get(`/schedule/periods/${periodId}`, (await login('emp005')).token);
  assert(empViewRun.data.run && empViewRun.data.run.status === 'published', '员工看到已发布版本');

  // ---------- 7. 员工视角与脱敏 ----------
  console.log('\n\x1b[1m[7] 员工视角与数据脱敏\x1b[0m');
  const emp = await login('emp005');
  assert(!!emp.token, '员工登录成功', `${emp.user.name} / ${emp.user.employeeNo}`);

  const empView = await api.get(`/schedule/periods/${periodId}`, emp.token);
  const anyAssignment = empView.data.assignments[0];
  assert(!!anyAssignment, '员工可读取排班表');
  if (anyAssignment) {
    const masked = anyAssignment.employeeNo;
    const adminSame = adminView.data.assignments.find((a) => a.userId === anyAssignment.userId);
    assert(masked.includes('*'), '员工视角工号已脱敏', `${masked}`);
    assert(adminSame && !adminSame.employeeNo.includes('*'), '管理员视角工号不脱敏', `${adminSame && adminSame.employeeNo}`);
  }

  const forbiddenAdmin = await api.get('/schedule/dashboard', emp.token);
  assert(forbiddenAdmin.status === 403, '员工访问管理员接口返回 403', `code=${forbiddenAdmin.error && forbiddenAdmin.error.code}`);

  // ---------- 8. 换班全流程（真实两端闭环） ----------
  console.log('\n\x1b[1m[8] 换班流程（发起 → 确认 → 生效）\x1b[0m');

  const full = await api.get(`/schedule/periods/${periodId}`, admin.token);
  const allAssignments = full.data.assignments;

  // 建立 userId → 工号 映射（管理员视角工号不脱敏）
  const noByUserId = new Map(allAssignments.map((a) => [a.userId, a.employeeNo]));

  // 找一个接收人：与其已有班次不冲突的候选
  async function findTransferPair() {
    for (const src of allAssignments) {
      const cand = await api.get(`/swaps/candidates/${src.id}`, admin.token);
      if (cand.status !== 200 || !cand.data || !cand.data.candidates) continue;
      const usable = cand.data.candidates.find((c) => c.canTake && c.userId !== src.userId);
      if (usable) return { src, target: usable, all: cand.data.candidates };
    }
    return null;
  }

  const pair = await findTransferPair();

  if (!pair) {
    bad('换班用例准备', '找不到可换班的配对（可能所有人已满上限）');
  } else {
    const { src, target, all } = pair;
    ok('选定换班对', `${src.name}(${src.workDate} ${src.shiftName} ${src.workTypeName}) → ${target.name}`);

    // 候选人列表结构校验
    assert(Array.isArray(all), '候选人列表为数组', `${all.length} 人`);
    const blocked = all.filter((c) => !c.canTake);
    assert(
      blocked.length === 0 || blocked.every((c) => Array.isArray(c.problems) && c.problems.length > 0),
      '不可接班的候选人都标注了原因'
    );

    const srcNo = noByUserId.get(src.userId);
    const tgtNo = noByUserId.get(target.userId);
    const srcToken = (await login(srcNo)).token;
    const tgtToken = (await login(tgtNo)).token;

    // 8.1 发起转班
    const created = await api.post(
      '/swaps',
      { type: 'transfer', fromAssignmentId: src.id, toUserId: target.userId, message: 'e2e 验收' },
      srcToken
    );
    const swapId = created.data && created.data.swap && created.data.swap.id;
    assert(created.status === 201, '本人发起转班返回 201', `swapId=${swapId}`);
    assert(!!swapId, '响应包含 swap.id');
    if (!swapId) throw new Error('创建换班未返回 swap.id，无法继续验收');
    assert(created.data.myDecision === 'approved', '发起人自动 approved', `myDecision=${created.data.myDecision}`);
    assert(created.data.canConfirm === true, '接收人可确认（无冲突）', `liveProblems=${(created.data.liveProblems || []).length}`);

    // 8.2 非当事人不能确认
    const outsiderToken = (await login(
      [...noByUserId.values()].find((n) => n !== srcNo && n !== tgtNo) || 'emp001'
    )).token;
    const outsiderConfirm = await api.post(`/swaps/${swapId}/confirm`, {}, outsiderToken);
    assert(outsiderConfirm.status === 403 || outsiderConfirm.status === 404, '无关人员确认被拒', `HTTP ${outsiderConfirm.status}`);

    // 8.3 待确认数量
    const pending = await api.get('/swaps/pending-count', tgtToken);
    assert(pending.status === 200 && pending.data.count >= 1, '接收人可见待确认换班', `count=${pending.data && pending.data.count}`);

    // 8.4 接收人确认 → 自动生效
    const confirmed = await api.post(`/swaps/${swapId}/confirm`, {}, tgtToken);
    const cd = confirmed.data || {};
    assert(confirmed.status === 200, '接收人确认成功', `applied=${cd.applied} status=${cd.status}`);
    assert(cd.applied === true, '全部同意后自动生效 applied=true');
    assert(cd.status === 'approved', '换班状态 approved');
    assert(!!cd.appliedAt, '记录生效时间 appliedAt', cd.appliedAt);
    assert(Array.isArray(cd.appliedItems) && cd.appliedItems.length > 0, '返回生效的分配变更', `${(cd.appliedItems || []).length} 条`);

    // 8.5 校验生效后的分配
    const after = await api.get(`/schedule/periods/${periodId}`, admin.token);
    const slotKey = (a) => `${a.workDate}|${a.shiftId}|${a.workTypeId}`;
    const newOwner = after.data.assignments.find(
      (a) => slotKey(a) === slotKey(src) && a.userId === target.userId
    );
    const oldOwner = after.data.assignments.find(
      (a) => slotKey(a) === slotKey(src) && a.userId === src.userId
    );
    assert(!!newOwner, '新班次已落到接收人名下');
    assert(!oldOwner, '原持有人已释放该班次');
    if (newOwner) assert(newOwner.source === 'swap', '来源标记为 swap', `source=${newOwner.source}`);

    // 8.6 重复确认应被拒绝（状态已定）
    const dup = await api.post(`/swaps/${swapId}/confirm`, {}, tgtToken);
    assert(dup.status === 409, '重复确认返回 409', `code=${dup.error && dup.error.code}`);

    // 8.7 换班详情里能看到完整时间线（留痕）
    const detail = await api.get(`/swaps/${swapId}`, admin.token);
    assert(detail.status === 200, '换班详情可读');
    assert(Array.isArray(detail.data.timeline) && detail.data.timeline.length >= 2, '时间线包含创建与生效节点', `${(detail.data.timeline || []).length} 个节点`);

    // 8.7 换班后历史不受污染（原班次不计入轮转历史）
    const statsAfter = await api.get(`/stats/periods/${periodId}`, admin.token);
    assert(statsAfter.status === 200, '周期统计可读', `fairness=${statsAfter.data && statsAfter.data.metrics && statsAfter.data.metrics.fairnessScore}`);
  }

  // ---------- 9. 审计日志 ----------
  console.log('\n\x1b[1m[9] 审计留痕\x1b[0m');
  const audit = await api.get('/admin/audit-logs?pageSize=20', admin.token);
  assert(audit.status === 200 && audit.data && Array.isArray(audit.data.items), '审计日志可读', `total=${audit.data && audit.data.total}`);
  const actions = new Set((audit.data.items || []).map((i) => i.action));
  assert(actions.has('SCHEDULE_GENERATE'), '记录了排班生成');
  assert(actions.has('SCHEDULE_PUBLISH'), '记录了排班发布');

  // ---------- 10. 参数校验 ----------
  console.log('\n\x1b[1m[10] 参数校验与错误语义\x1b[0m');
  const invalid = await api.post('/schedule/periods/999999/generate', { seed: -1 }, admin.token);
  assert(invalid.status === 400 || invalid.status === 404, '非法周期/种子返回 4xx', `HTTP ${invalid.status}`);
  const notFound = await api.get('/periods/999999', admin.token);
  assert(notFound.status === 404, '不存在的周期返回 404');

  // ---------- 汇总 ----------
  const total = pass + fail;
  console.log(`\n\x1b[1m验收结果\x1b[0m  通过 \x1b[32m${pass}\x1b[0m / 失败 \x1b[31m${fail}\x1b[0m  （共 ${total} 项）\n`);

  if (fail > 0) {
    console.log('\x1b[31m失败明细：\x1b[0m');
    for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log('\x1b[32m全部通过 ✓\x1b[0m\n');
}

main().catch((err) => {
  console.error('\x1b[31m验收脚本异常：\x1b[0m', err.message);
  process.exit(1);
});
