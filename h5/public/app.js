'use strict';

/**
 * H5 预览主逻辑 —— 渲染排班矩阵、缺口、公平度指标、换班与审计。
 * 纯 DOM 操作，无框架依赖。
 */

const TOKEN_TTL_NOTE = '登录态 30 天有效';

const state = {
  user: null,
  period: null,
  schedule: null,
  lastRunId: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ------------------------------ 工具函数 ------------------------------

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 2026-11-05 → 11月05日 周四 */
function friendlyDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}月${String(d).padStart(2, '0')}日 ${WEEK_CN[dt.getDay()]}`;
}

function shortDateTime(iso) {
  if (!iso) return '';
  return iso.replace('T', ' ').slice(5, 16);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast hidden';
  }, 2600);
}

// ------------------------------ 登录 ------------------------------

async function doLogin() {
  const no = $('#login-no').value.trim();
  const pwd = $('#login-pwd').value.trim();
  if (!no || !pwd) return toast('请输入工号和密码', true);

  const btn = $('#btn-login');
  btn.disabled = true;
  btn.textContent = '登录中...';
  try {
    const data = await API.login(no, pwd);
    API.setSession(data.token, data.user);
    state.user = data.user;
    toast(`欢迎回来，${data.user.name}`);
    await enterMain();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '登 录';
  }
}

async function doLogout() {
  try {
    await API.logout();
  } catch {
    /* 忽略：本地清除即可 */
  }
  API.clearSession();
  state.user = null;
  state.schedule = null;
  showView('login');
}

function showView(name) {
  $('#view-login').classList.toggle('hidden', name !== 'login');
  $('#view-main').classList.toggle('hidden', name !== 'main');
}

// ------------------------------ 主视图 ------------------------------

async function enterMain() {
  showView('main');
  const u = state.user || API.getUser();
  const isAdmin = u && u.role === 'admin';
  $('#tb-user').textContent = `${u.name}（${u.employeeNo}${isAdmin ? ' · 管理员' : ''}）`;
  $('#tb-tab-admin').classList.toggle('hidden', !isAdmin);

  if (!isAdmin) switchTab('schedule');

  await loadPeriod();
  await renderSchedule();
  if (isAdmin) await renderAdmin();
}

function switchTab(tab) {
  $$('.tb-tab').forEach((el) => el.classList.toggle('on', el.dataset.tab === tab));
  $('#tab-schedule').classList.toggle('hidden', tab !== 'schedule');
  $('#tab-admin').classList.toggle('hidden', tab !== 'admin');
}

async function loadPeriod() {
  state.period = await API.currentPeriod();
}

// ------------------------------ 排班矩阵 ------------------------------

async function renderSchedule() {
  const box = $('#matrix');
  const banner = $('#gap-banner');

  if (!state.period) {
    box.innerHTML = '<div class="empty-tip">还没有排班周期</div>';
    banner.classList.add('hidden');
    return;
  }

  let data;
  try {
    data = await API.schedule(state.period.id);
  } catch (err) {
    box.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    return;
  }
  state.schedule = data;

  // 缺口 banner
  const gaps = data.gaps;
  if (!data.run) {
    banner.classList.add('hidden');
  } else if (gaps && gaps.totalGap > 0) {
    banner.classList.remove('hidden');
    banner.innerHTML = `⚠️ 当前排班有 <b>${gaps.totalGap}</b> 个岗位缺口（已排 ${gaps.totalFilled}/${gaps.totalNeeded}，填充率 ${(gaps.fillRate * 100).toFixed(1)}%），可在下方红色标记处查看`;
  } else {
    banner.classList.remove('hidden');
    banner.style.background = '#E8F5EE';
    banner.style.color = '#2E9E5B';
    banner.innerHTML = `✅ 本周期 ${data.run.totalFilled}/${data.run.totalNeeded} 岗位已全部排满${data.run.status === 'draft' ? '（草稿未发布）' : ''}`;
  }

  if (!data.matrix || !data.matrix.length) {
    box.innerHTML = `<div class="empty-tip">${escapeHtml(data.message || '该周期还没有生成排班')}</div>`;
    return;
  }

  const myId = (state.user || API.getUser() || {}).id;
  const html = data.matrix
    .map((day) => {
      const shiftsHtml = day.shifts
        .map((shift) => {
          const wtHtml = shift.workTypes
            .map((wt) => {
              const people = wt.assigned
                .map((p) => {
                  const cls = ['person'];
                  if (p.userId === myId) cls.push('mine');
                  if (p.source === 'swap') cls.push('swap');
                  const tip = p.source === 'swap' ? '（换班后）' : '';
                  return `<span class="${cls.join(' ')}" title="${escapeHtml(p.employeeNo)}${tip}">${escapeHtml(p.name)}</span>`;
                })
                .join('');

              const countTag =
                wt.gap > 0
                  ? `<span class="gap-badge">缺 ${wt.gap}</span>`
                  : `<span class="count-tag">${wt.filled}/${wt.needCount}</span>`;

              return `<div class="wt-row">
                <div class="wt-name"><span class="dot" style="background:${escapeHtml(wt.workTypeColor || '#999')}"></span>${escapeHtml(wt.workTypeName)}</div>
                <div class="wt-people">${people || '<span class="count-tag">无人</span>'}${countTag}</div>
              </div>`;
            })
            .join('');

          return `<div class="shift-block">
            <div class="shift-head">
              <span class="shift-name">${escapeHtml(shift.shiftName)}</span>
            </div>
            ${wtHtml}
          </div>`;
        })
        .join('');

      return `<div class="day-card">
        <div class="day-head">${friendlyDate(day.workDate)}</div>
        ${shiftsHtml}
      </div>`;
    })
    .join('');

  box.innerHTML = html || '<div class="empty-tip">暂无数据</div>';
}

// ------------------------------ 管理后台 ------------------------------

async function renderAdmin() {
  await Promise.all([renderStats(), renderGenResult(), renderMetrics(), renderSwaps(), renderAudit()]);
}

async function renderStats() {
  const el = $('#admin-stats');
  try {
    const d = await API.dashboard();
    const p = d.currentPeriod || {};
    const run = d.publishedRun;
    const fillRate = run ? `${(run.fillRate * 100).toFixed(0)}%` : '—';

    el.innerHTML = `
      <div class="stat"><span class="v">${d.enrollment.submitted}/${d.enrollment.total}</span><span class="l">报名人数</span></div>
      <div class="stat"><span class="v">${run ? `${run.totalFilled}/${run.totalNeeded}` : '—'}</span><span class="l">已排 / 需求</span></div>
      <div class="stat"><span class="v">${fillRate}</span><span class="l">填充率</span></div>
      <div class="stat"><span class="v">${d.pendingSwaps}</span><span class="l">待确认换班</span></div>
    `;

    if (p.id) {
      state.period = p;
      $('#gen-seed').value = run ? 42 : 42;
    }
  } catch (err) {
    el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
  }
}

function renderGenResult() {
  const run = state.schedule && state.schedule.run;
  const box = $('#gen-result');

  if (!run) {
    box.innerHTML = '<div class="empty-tip">该周期还没有排班草稿，点「生成排班」开始</div>';
    $('#btn-publish').classList.add('hidden');
    $('#btn-regen').classList.add('hidden');
    return;
  }

  const isDraft = run.status === 'draft';
  box.innerHTML = `
    <div class="gap-item" style="background:#F8FAFF">
      run #${run.id} · ${run.status === 'published' ? '已发布' : '草稿'} · 种子 ${run.seed} · 填充 ${run.totalFilled}/${run.totalNeeded}（${(run.fillRate * 100).toFixed(1)}%）
      <span class="reason">算法 ${escapeHtml(run.algoVersion)} · ${run.rounds} 轮迭代 · ${run.durationMs}ms · hash ${escapeHtml(run.inputHash)}</span>
    </div>
  `;
  $('#btn-publish').classList.toggle('hidden', !isDraft);
  $('#btn-regen').classList.remove('hidden');
}

async function renderMetrics() {
  const box = $('#metrics-detail');
  const m = state.schedule && state.schedule.metrics;
  if (!m) {
    box.textContent = '生成排班后这里会显示每个工作类型的轮转分布';
    return;
  }

  const gradeMap = {
    excellent: '优秀',
    good: '良好',
    fair: '一般',
    poor: '较差',
  };

  const blocks = m.perWorkType
    .map((wt) => {
      const max = Math.max(...wt.distribution.map((d) => d.count), 1);
      const rows = wt.distribution
        .slice(0, 12)
        .map((d) => {
          const pct = Math.max(4, Math.round((d.count / max) * 100));
          return `<div class="bar-row">
            <span class="bar-name">${escapeHtml(d.name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${escapeHtml(wt.workTypeColor || '#4A90D9')}"></span></span>
            <span class="bar-count">${d.count}</span>
          </div>`;
        })
        .join('');

      return `<div class="m-block">
        <div class="m-title">
          <span>${escapeHtml(wt.workTypeName)}（${wt.eligibleCount} 人可胜任，共 ${wt.totalAssigned} 人次）</span>
          <span class="std">标准差 ${wt.std} · 极差 ${wt.range}</span>
        </div>
        ${rows}
      </div>`;
    })
    .join('');

  const wl = m.workload;
  const wlMax = Math.max(...wl.distribution.map((d) => d.assigned), 1);
  const wlRows = wl.distribution
    .slice(0, 12)
    .map((d) => {
      const pct = Math.max(4, Math.round((d.assigned / wlMax) * 100));
      return `<div class="bar-row">
        <span class="bar-name">${escapeHtml(d.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:#2E5AAC"></span></span>
        <span class="bar-count">${d.assigned}</span>
      </div>`;
    })
    .join('');

  box.innerHTML = `
    <div class="gap-item" style="background:#F8FAFF;margin-bottom:14px">
      公平度评分 <b>${m.fairnessScore}</b> · 评级 <b>${gradeMap[m.grade] || m.grade}</b>
      <span class="reason">工作量 人均 ${wl.avg} 班，标准差 ${wl.std}，最多 ${wl.max} / 最少 ${wl.min}</span>
    </div>
    ${blocks}
    <div class="m-block">
      <div class="m-title"><span>工作量分布（每人本周期班次数）</span><span class="std">标准差 ${wl.std}</span></div>
      ${wlRows}
    </div>
  `;
}

async function renderSwaps() {
  const box = $('#swap-records');
  if (!state.period) return;

  const statusText = { pending: '待确认', approved: '已生效', rejected: '已拒绝', cancelled: '已撤回' };

  try {
    const list = await API.adminSwaps(state.period.id);
    if (!list.length) {
      box.innerHTML = '<div class="empty-tip">暂无换班记录</div>';
      return;
    }
    box.innerHTML = list
      .map((s) => {
        const dir = s.type === 'exchange' ? `⇄ ${s.toWorkDate || ''} ${s.toShiftName || ''} ${s.toWorkTypeName || ''}` : '转班';
        const when = s.type === 'exchange' ? '' : `→ ${escapeHtml(s.toUserName)}`;
        return `<div class="swap-item">
          <span>${escapeHtml(s.requesterName)}${when}：${escapeHtml(s.fromWorkDate)} ${escapeHtml(s.fromShiftName)} ${escapeHtml(s.fromWorkTypeName)}
            <span class="reason">${dir}</span></span>
          <span class="swap-status ${s.status}">${statusText[s.status] || s.status}</span>
        </div>`;
      })
      .join('');
  } catch (err) {
    box.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
  }
}

async function renderAudit() {
  const box = $('#audit-list');
  try {
    const d = await API.auditLogs(15);
    if (!d.items.length) {
      box.innerHTML = '<div class="empty-tip">暂无日志</div>';
      return;
    }
    box.innerHTML = d.items
      .map(
        (it) => `<div class="audit-item">
          <span class="audit-action">${escapeHtml(it.actionLabel || it.action)}<span class="audit-actor">${escapeHtml(it.actorName || '-')}</span></span>
          <span class="audit-time">${shortDateTime(it.createdAt)}</span>
        </div>`
      )
      .join('');
  } catch (err) {
    box.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
  }
}

// ------------------------------ 动作 ------------------------------

async function onGenerate() {
  if (!state.period) return toast('没有可排班的周期', true);
  const seed = Number($('#gen-seed').value) || 42;
  const btn = $('#btn-gen');
  btn.disabled = true;
  btn.textContent = '生成中...';
  try {
    const res = await API.generate(state.period.id, seed);
    state.lastRunId = res.runId;
    toast(`生成完成：${res.gaps.totalFilled}/${res.gaps.totalNeeded}，缺口 ${res.gaps.totalGap}`);
    await renderSchedule();
    await renderAdmin();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '生成排班';
  }
}

async function onPublish() {
  if (!state.period) return;
  const btn = $('#btn-publish');
  btn.disabled = true;
  try {
    const runId = state.lastRunId || (state.schedule && state.schedule.run ? state.schedule.run.id : undefined);
    const res = await API.publish(state.period.id, runId);
    toast(res.alreadyPublished ? '该排班已发布过' : `发布成功，共 ${res.filled} 条排班生效`);
    await loadPeriod();
    await renderSchedule();
    await renderAdmin();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function onRegen() {
  const el = $('#gen-seed');
  el.value = String(Math.floor(Math.random() * 9000) + 1000);
  await onGenerate();
}

// ------------------------------ 绑定与启动 ------------------------------

function bindEvents() {
  $('#btn-login').addEventListener('click', doLogin);
  $('#login-pwd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });
  $('#login-no').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#login-pwd').focus();
  });

  $('#btn-logout').addEventListener('click', doLogout);

  $$('.tb-tab').forEach((el) => {
    el.addEventListener('click', () => {
      switchTab(el.dataset.tab);
      if (el.dataset.tab === 'admin') renderAdmin();
    });
  });

  $('#btn-gen').addEventListener('click', onGenerate);
  $('#btn-publish').addEventListener('click', onPublish);
  $('#btn-regen').addEventListener('click', onRegen);
}

async function boot() {
  bindEvents();
  const token = API.getToken();
  const user = API.getUser();

  if (token && user) {
    try {
      state.user = await API.me();
      await enterMain();
      return;
    } catch {
      API.clearSession();
    }
  }
  showView('login');
  // 演示提示
  console.info('[排班宝] ' + TOKEN_TTL_NOTE);
}

document.addEventListener('DOMContentLoaded', boot);
