'use strict';

/**
 * H5 预览主逻辑 —— 渲染排班矩阵、缺口、公平度指标、换班与审计。
 * 纯 DOM 操作，无框架依赖。
 */

function isAdminUser(user = state.user) { return ['admin', 'super_admin'].includes(user?.role); }
const TOKEN_TTL_NOTE = '登录态 30 天有效';

const state = {
  user: null,
  period: null,
  schedule: null,
  lastRunId: null,
  draftSchedule: null,
  publishedSchedule: null,
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
  if (!window.confirm('确定退出登录？')) return;
  const button = $('#btn-logout');
  button.disabled = true;
  try { await API.logout(); } catch { /* 清除本地会话即可 */ }
  finally { clearLocalSession(); button.disabled = false; }
}

function clearLocalSession() {
  resetPasswordForm();
  $('#help-dialog').close();
  API.clearSession();
  $('#login-pwd').value = '';
  state.user = null;
  state.schedule = null;
  state.period = null;
  state.lastRunId = null;
  state.draftSchedule = null;
  state.publishedSchedule = null;
  $('#publish-dialog').close();
  $('#admin-adjust-dialog').close();
  resetAdminEnrollment();
  resetPeriodTrash();
  resetWorkflow();
  resetRecentSchedule();
  resetScheduleViews();
  resetEmployee();
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
  const isAdmin = isAdminUser(u);
  $('#tb-user').textContent = `${u.name}（${u.employeeNo}${isAdmin ? (u.role === 'super_admin' ? ' · 超级管理员' : ' · 管理员') : ''}）`;
  $('#tb-tab-admin').classList.toggle('hidden', !isAdmin);
  $('#tb-tab-config').classList.toggle('hidden', !isAdmin);
  $$('.employee-tab').forEach((el) => el.classList.remove('hidden'));
  $('.main-nav').classList.toggle('has-admin-nav', isAdmin);

  switchTab('schedule');

  await loadPeriod();
  await renderSchedule();
  if (isAdmin) await renderAdmin();
}

function switchTab(tab) {
  $$('.tb-tab').forEach((el) => el.classList.toggle('on', el.dataset.tab === tab));
  $$('.tabpane').forEach((el) => el.classList.toggle('hidden', el.id !== `tab-${tab}`));
}

async function loadPeriod() {
  state.period = await API.currentPeriod();
}

// ------------------------------ 排班矩阵 ------------------------------

async function renderSchedule() {
  const box = $('#matrix');
  const banner = $('#gap-banner');
  $('#schedule-view').value = scheduleView.mode;
  $('#recent-controls').classList.toggle('hidden', scheduleView.mode !== 'recent');
  $('.schedule-controls').classList.toggle('hidden', scheduleView.mode === 'recent' || !state.period);
  $('#schedule-daily-option').disabled = !isAdminUser();
  $('#schedule-daily-option').hidden = !isAdminUser();
  if (scheduleView.mode === 'recent') { banner.classList.add('hidden'); return renderRecentSchedule(); }
  recentView.request++;

  if (!state.period) {
    state.schedule = null;
    $('#schedule-period-label').textContent = '暂无排班周期';
    $('.schedule-controls').classList.add('hidden');
    box.innerHTML = '<div class="empty-tip">还没有排班周期</div>';
    banner.classList.add('hidden');
    return;
  }

  let data;
  const periodId = state.period.id;
  try {
    const result = await Promise.all([API.schedule(periodId, 'published'), API.listPeriods()]);
    if (!state.user || state.period?.id !== periodId) return;
    data = result[0];
    state.periods = result[1];
  } catch (err) {
    box.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
    return;
  }
  state.schedule = data;
  $('.schedule-controls').classList.remove('hidden');

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

  renderScheduleViews(data);
}

function scheduleMatrixHtml(data) {
  if (!data?.matrix?.length) return '<div class="empty-tip">暂无排班明细</div>';
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
                  const tip = p.isFixed ? '（固定）' : p.source === 'manual' ? '（管理员调配）' : p.source === 'swap' ? '（换班后）' : '';
                  return `<span class="${cls.join(' ')}" title="${escapeHtml(p.employeeNo)}${tip}">${escapeHtml(p.name)}${tip}${p.dutyRole && p.dutyRole !== 'member' ? ` · ${dutyRoleLabels[p.dutyRole]}` : ''}</span>`;
                })
                .join('');

              const countTag =
                wt.gap > 0
                  ? `<span class="gap-badge">缺 ${wt.gap}</span>`
                  : `<span class="count-tag">${wt.filled}/${wt.needCount}</span>`;

              return `<div class="wt-row">
                <div class="wt-name"><span class="dot" style="background:${escapeHtml(wt.workTypeColor || '#999')}"></span>${escapeHtml(wt.workTypeName)}</div>
                <div class="wt-people">${people || '<span class="count-tag">无人</span>'}${countTag}${(wt.roleGaps || []).map((role) => `<span class="gap-badge">缺${dutyRoleLabels[role]}</span>`).join('')}</div>
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

  return html || '<div class="empty-tip">暂无数据</div>';
}

// ------------------------------ 管理后台 ------------------------------

async function renderAdmin() {
  await renderWorkflow();
  await Promise.all([loadAdminSchedules(), renderSwaps(), renderAudit()]);
  await renderStats();
  renderGenResult();
  renderMetrics();
}

async function loadAdminSchedules() {
  state.draftSchedule = null;
  state.publishedSchedule = null;
  state.scheduleError = null;
  $('#btn-publish').disabled = true;
  if (!state.period) return;
  const id = state.period.id;
  try {
    const [draft, published] = await Promise.all([API.schedule(id, 'draft'), API.schedule(id, 'published')]);
    if (!isAdminUser() || state.period?.id !== id) return;
    state.draftSchedule = draft;
    state.publishedSchedule = published;
  } catch (err) { state.scheduleError = err.message; }
}

async function renderStats() {
  const el = $('#admin-stats');
  if (!state.period) { el.innerHTML = ''; return; }
  try {
    const d = await API.get(`/enrollments/${state.period.id}`);
    const run = state.publishedSchedule?.run;
    const fillRate = run ? `${(run.fillRate * 100).toFixed(0)}%` : '—';

    el.innerHTML = `
      <div class="stat"><span class="v">${d.effectiveCount ?? d.submittedCount}/${d.totalEmployees}</span><span class="l">参与排班人数</span></div>
      <div class="stat"><span class="v">${run ? `${run.totalFilled}/${run.totalNeeded}` : '—'}</span><span class="l">已排 / 需求</span></div>
      <div class="stat"><span class="v">${fillRate}</span><span class="l">填充率</span></div>
      <div class="stat"><span class="v">${state.pendingPeriodSwaps || 0}</span><span class="l">待确认换班</span></div>
    `;

  } catch (err) {
    el.innerHTML = `<div class="empty-tip">${escapeHtml(err.message)}</div>`;
  }
}

function renderGenResult() {
  const draft = state.draftSchedule;
  const published = state.publishedSchedule;
  const run = draft?.run;
  const box = $('#gen-result');
  $('#draft-panel').classList.toggle('hidden', !run);
  $('#published-panel').classList.toggle('hidden', !published?.run);
  $('#draft-preview').innerHTML = run ? scheduleMatrixHtml(draft) : '<p class="empty-tip">还没有待发布草稿，请先生成。</p>';
  $('#published-preview').innerHTML = published?.run ? scheduleMatrixHtml(published) : '<p class="empty-tip">该周期尚未发布，员工暂时看不到本周期排班。</p>';
  $('#published-summary').textContent = published?.run ? `生效版本 #${published.run.id} · 已安排 ${published.assignments.length} 人次` : '';
  if (state.scheduleError) {
    box.innerHTML = `<p class="form-error" role="alert">${escapeHtml(state.scheduleError)}，请刷新后重试。</p>`;
    $('#btn-publish').classList.add('hidden');
    return;
  }

  if (!run) {
    box.innerHTML = '';
    $('#btn-publish').classList.add('hidden');
    $('#btn-regen').classList.add('hidden');
    return;
  }

  const fixedConflicts = draft.gaps?.fixedConflicts || [];
  const roleGaps = draft.matrix.flatMap((day) => day.shifts.flatMap((shift) => shift.workTypes.flatMap((w) => w.roleGaps || [])));
  box.innerHTML = `
    <p class="notice">草稿 #${run.id}：已安排 <b>${run.totalFilled}</b> 人次，需求 <b>${run.totalNeeded}</b> 人次，缺口 <b>${run.totalNeeded - run.totalFilled}</b> 人次。尚未生效。</p>
    ${fixedConflicts.length ? `<p class="form-error">固定名单冲突：</p><ul>${fixedConflicts.map((c) => `<li>${escapeHtml(c.workDate)} ${escapeHtml(c.name || '')}：${escapeHtml(c.message)}</li>`).join('')}</ul>` : ''}
    ${roleGaps.length ? '<p class="form-error">主副负责人未配齐，暂不可发布。</p>' : ''}
  `;
  $('#btn-publish').classList.remove('hidden');
  $('#btn-publish').disabled = roleGaps.length > 0 || fixedConflicts.length > 0;
  $('#btn-regen').classList.remove('hidden');
  $('#btn-regen').disabled = !flow.preparation?.canGenerate;
}

async function renderMetrics() {
  const box = $('#metrics-detail');
  const m = (state.draftSchedule?.run ? state.draftSchedule : state.publishedSchedule)?.metrics;
  $('#metrics-panel').classList.toggle('hidden', !m);
  if (!m) {
    box.textContent = '暂无统计';
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
    state.pendingPeriodSwaps = list.filter((s) => s.status === 'pending').length;
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
  const ready = await refreshWorkflowPreparation();
  if (!ready) return;
  if (!ready.canGenerate) { await openWorkflow(ready.nextStep); return; }
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
    btn.disabled = !flow.preparation?.canGenerate;
    btn.textContent = '生成草稿';
  }
}

async function onPublish() {
  await loadAdminSchedules();
  renderGenResult();
  const draft = state.draftSchedule;
  if (!draft?.run || $('#btn-publish').disabled) return;
  const published = state.publishedSchedule;
  const key = (a) => `${a.workDate}|${a.shiftId}|${a.workTypeId}|${a.dutyRole || 'member'}|${a.userId}`;
  const oldKeys = new Set((published?.assignments || []).map(key));
  const newKeys = new Set(draft.assignments.map(key));
  const added = draft.assignments.filter((a) => !oldKeys.has(key(a)));
  const removed = (published?.assignments || []).filter((a) => !newKeys.has(key(a)));
  const changeList = (title, list) => `<h3>${title}（${list.length} 人次）</h3>${list.length ? `<ul class="participant-list">${list.map((a) => `<li>${escapeHtml(assignmentLabel(a))}：${escapeHtml(a.name)}</li>`).join('')}</ul>` : '<p class="form-help">无</p>'}`;
  state.reviewedRunId = draft.run.id;
  state.reviewedRevision = draft.run.revision;
  state.reviewedPublishedRunId = published?.run?.id || 0;
  state.reviewedPublishedRevision = published?.run?.revision || 0;
  state.reviewedPeriodId = state.period.id;
  $('#publish-review-content').innerHTML = `<p class="notice">周期：${escapeHtml(state.period.name)}<br>本次发布草稿 #${draft.run.id}，共 ${draft.assignments.length} 人次。${published?.run ? `将替换当前生效版本 #${published.run.id}。` : '这是本周期首次发布。'}</p>

    ${draft.run.totalNeeded > draft.run.totalFilled ? `<p class="form-error">草稿仍有 ${draft.run.totalNeeded - draft.run.totalFilled} 人次缺口，发布后这些岗位仍为空缺。</p>` : ''}
    ${changeList('新增 / 调整', added)}${changeList('移出', removed)}<p class="form-help">不变：${draft.assignments.length - added.length} 人次。</p>`;
  $('#publish-error').textContent = '';
  $('#publish-dialog').showModal();
}

async function confirmPublish() {
  const btn = $('#btn-publish-confirm');
  if (btn.disabled || !state.reviewedRunId) return;
  btn.disabled = true;
  try {
    const res = await API.publish(state.reviewedPeriodId, state.reviewedRunId, state.reviewedRevision, state.reviewedPublishedRunId, state.reviewedPublishedRevision);
    $('#publish-dialog').close();
    state.lastRunId = null;
    toast(res.alreadyPublished ? '该排班已发布过' : `发布成功，共 ${res.filled} 条排班生效`);
    state.period = (await API.listPeriods()).find((p) => p.id === state.period.id) || state.period;
    await renderSchedule();
    await renderAdmin();
  } catch (err) {
    $('#publish-error').textContent = err.message;
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
      if (!confirmWorkflowLeave()) return;
      switchTab(el.dataset.tab);
      if (el.dataset.tab === 'admin') renderAdmin();
      if (el.dataset.tab === 'config') renderWorkConfig();
      if (el.dataset.tab === 'enroll') renderEnrollment();
      if (el.dataset.tab === 'swaps') renderEmployeeSwaps();
      if (el.dataset.tab === 'schedule') renderSchedule();
    });
  });

  $('#btn-gen').addEventListener('click', onGenerate);
  $('#btn-publish').addEventListener('click', onPublish);
  $('#btn-regen').addEventListener('click', onRegen);
  $('#btn-publish-cancel').addEventListener('click', () => $('#publish-dialog').close());
  $('#btn-publish-confirm').addEventListener('click', confirmPublish);
  bindEmployeeEvents();
  bindWorkConfigEvents();
  bindWorkflowEvents();
  bindPeriodTrashEvents();
  bindAdminEnrollmentEvents();
  bindHelpEvents();
  bindPasswordEvents();
  bindAccountEvents();
  bindAdminScheduleEvents();
  bindScheduleViewEvents();
  bindRecentScheduleEvents();
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
