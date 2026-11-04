'use strict';

const employee = { context: null, assignments: [], candidates: [], detail: null, saving: false, acting: false, month: null };
const periodLabels = { draft: '未开放', enrolling: '报名中', scheduling: '排班中', published: '已发布', archived: '已归档' };
const swapLabels = { pending: '待确认', approved: '已生效', rejected: '已拒绝', cancelled: '已撤回', expired: '已过期' };
const dutyRoleLabels = { member: '普通成员', primary: '主负责人', deputy: '副负责人', both: '主副皆可', either: '主/副额外名额' };

function resetEmployee() {
  employee.context = null;
  employee.assignments = [];
  employee.candidates = [];
  employee.detail = null;
  employee.month = null;
  $('#enroll-period').innerHTML = '';
  ['enroll-content', 'swap-create-content', 'swap-inbox', 'swap-mine', 'swap-detail-content'].forEach((id) => { $(`#${id}`).innerHTML = ''; });
  $('#swap-dialog').close();
}

function employeeError(err) {
  const problems = err.details && err.details.problems;
  return problems && problems.length ? `${err.message}：${problems.map((p) => p.label || p.message).join('；')}` : err.message;
}

function errorMarkup(err) {
  return `<p class="form-error" role="alert">${escapeHtml(employeeError(err))}</p>`;
}

function assignmentLabel(a) {
  return a ? `${a.workDate} ${a.shiftName} · ${a.workTypeName}${a.dutyRole && a.dutyRole !== 'member' ? ` · ${dutyRoleLabels[a.dutyRole]}` : ''}` : '班次记录已不可用';
}

// ------------------------------ 员工报名 ------------------------------

async function renderEnrollment() {
  const box = $('#enroll-content');
  const select = $('#enroll-period');
  box.innerHTML = '<p class="empty-tip">正在加载报名信息…</p>';
  select.disabled = true;
  employee.context = null;
  try {
    const periods = await API.listPeriods();
    if (!state.user) return;
    const selected = periods.find((p) => String(p.id) === select.value)
      || periods.find((p) => p.status === 'enrolling')
      || periods.find((p) => p.id === state.period?.id) || periods[0];
    select.innerHTML = periods.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}（${periodLabels[p.status] || escapeHtml(p.status)}）</option>`).join('');
    if (!selected) {
      box.innerHTML = `<p class="empty-tip">${isAdminUser() ? '暂无排班周期，请在「安排排班」中创建周期并开放报名。' : '暂无排班周期，请等待管理员创建并开放报名。'}</p>`;
      return;
    }
    select.value = selected.id;
    select.disabled = false;
    await loadEnrollment();
  } catch (err) {
    box.innerHTML = errorMarkup(err);
  }
}

async function loadEnrollment() {
  const id = $('#enroll-period').value;
  const box = $('#enroll-content');
  employee.context = null;
  box.innerHTML = '<p class="empty-tip">正在加载报名信息…</p>';
  try {
    const [ctx, mine] = await Promise.all([API.enrollContext(id), API.myEnrollment(id)]);
    if (!state.user || $('#enroll-period').value !== id) return;
    employee.context = ctx;
    const editable = ['enrolling', 'scheduling'].includes(ctx.period.status);
    const chosen = new Map(mine.workTypes.map((w) => [w.workTypeId, w.priority]));
    const roles = new Map(mine.workTypes.map((w) => [w.workTypeId, w.dutyRole]));
    const available = new Set(mine.availability.map((a) => `${a.workDate}|${a.shiftId}`));
    const blocked = new Map(mine.unavailability.map((u) => [u.workDate, u.reason || '']));
    const status = mine.exists ? (mine.status === 'submitted' ? '已提交' : '草稿') : ctx.fixedAssignments?.length ? '已按固定名单参与' : '尚未报名';
    const months = [...new Set(ctx.dates.map((date) => date.slice(0, 7)))];
    const month = months.includes(employee.month) ? employee.month : months[0];
    employee.month = month;
    box.innerHTML = `
      <p class="form-help">${escapeHtml(ctx.period.startDate)} 至 ${escapeHtml(ctx.period.endDate)} · ${escapeHtml(status)}</p>
      ${ctx.fixedAssignments?.length ? `<div class="notice">长期固定安排：<ul>${ctx.fixedAssignments.map((a) => `<li>${escapeHtml(a.workTypeName)} · ${weekdayLabels[a.weekday]} · ${escapeHtml(a.shiftName)} · ${dutyRoleLabels[a.dutyRole]}</li>`).join('')}</ul></div>` : ''}
      ${editable ? '' : '<p class="notice">当前不可报名，仅供查看。</p>'}
      <form id="enroll-form">
        <fieldset>
          <legend>工作与意愿</legend>

          <div class="worktype-options">${ctx.workTypes.map((w) => `
            <div class="worktype-option">
              <label><input type="checkbox" name="workType" value="${w.id}" ${chosen.has(w.id) ? 'checked' : ''}> ${escapeHtml(w.name)}</label>
              ${w.weekdays && w.weekdays.length < 7 ? `<p class="form-help">开放日期：${w.weekdays.map((day) => weekdayLabels[day]).join('、') || '尚未设置'}</p>` : ''}
              <select name="priority-${w.id}" aria-label="${escapeHtml(w.name)}意愿优先级" ${chosen.has(w.id) ? '' : 'disabled'}>
                ${[1, 2, 3].map((p) => `<option value="${p}" ${chosen.get(w.id) === p ? 'selected' : ''}>${p} 级${p === 1 ? '（最优先）' : ''}</option>`).join('')}
              </select>
              ${w.requiresRoles ? `<label class="field">报名角色<select name="role-${w.id}" aria-label="${escapeHtml(w.name)}报名角色" required ${chosen.has(w.id) ? '' : 'disabled'}><option value="">请选择负责人角色</option>${['primary', 'deputy', 'both'].map((role) => `<option value="${role}" ${roles.get(w.id) === role ? 'selected' : ''}>${dutyRoleLabels[role]}</option>`).join('')}</select></label>` : ''}
            </div>`).join('') || '<p class="form-help">管理员尚未配置工作类型。</p>'}</div>
          <label class="field"><span class="field-label">本周期班次上限 ${helpButton('limit')}</span><input id="enroll-max" type="number" min="0" step="1" value="${mine.maxShifts ?? ''}" placeholder="不限"></label>
          <h3>可用时间 ${helpButton('availability')}</h3>

          <label class="field">查看月份<select id="enroll-month">${months.map((m) => `<option value="${m}" ${m === month ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
          <div class="availability-grid">${ctx.dates.map((date) => {
            const cells = ctx.shifts.map((s) => ({ ...s, checked: !blocked.has(date) && (!available.size || available.has(`${date}|${s.id}`)) }));
            const allBlocked = cells.length > 0 && cells.every((s) => !s.checked);
            return `<div class="availability-day ${date.slice(0, 7) === month ? '' : 'hidden'}" data-date="${escapeHtml(date)}">
              <div class="day-heading"><b>${friendlyDate(date)}</b><label><input type="checkbox" class="block-day" ${allBlocked ? 'checked' : ''}> 整天不可用</label></div>
              <div class="shift-options">${cells.map((s) => `<label><input type="checkbox" class="avail-cell" value="${s.id}" ${s.checked ? 'checked' : ''}> ${escapeHtml(s.name)} <span class="form-help">${escapeHtml(s.startTime || '')}–${escapeHtml(s.endTime || '')}</span></label>`).join('')}</div>
              <input class="leave-reason ${allBlocked ? '' : 'hidden'}" aria-label="${escapeHtml(date)}请假原因" placeholder="请假原因（可选）" value="${escapeHtml(blocked.get(date) || '')}" maxlength="200">
            </div>`;
          }).join('') || '<p class="form-help">管理员尚未配置排班日期或班次。</p>'}</div>
          <label class="field">备注<textarea id="enroll-note" rows="3" maxlength="1000">${escapeHtml(mine.note || '')}</textarea></label>
          <p id="enroll-error" class="form-error" role="alert"></p>
          <div class="form-actions"><button class="btn-ghost" type="submit" value="draft" formnovalidate>保存草稿</button><button class="btn-success" type="submit" value="submit" ${!ctx.workTypes.length || !ctx.dates.length || !ctx.shifts.length ? 'disabled' : ''}>提交报名</button></div>
        </fieldset>
      </form>`;
    if (!editable) box.querySelectorAll('input, select, textarea, button:not([data-help])').forEach((el) => { el.disabled = true; });
  } catch (err) {
    if ($('#enroll-period').value === id) box.innerHTML = errorMarkup(err);
  }
}

async function saveEmployeeEnrollment(event) {
  event.preventDefault();
  if (employee.saving || !employee.context) return;
  const submit = event.submitter?.value !== 'draft';
  const form = event.target;
  const workTypes = Array.from(form.querySelectorAll('[name="workType"]:checked')).map((el) => ({ workTypeId: Number(el.value), priority: Number(form.elements[`priority-${el.value}`].value), dutyRole: form.elements[`role-${el.value}`]?.value || 'member' }));
  if (submit && !workTypes.length && !employee.context.fixedAssignments?.length) {
    $('#enroll-error').textContent = '请至少选择一种工作类型。';
    return;
  }
  const availability = [];
  const unavailability = [];
  form.querySelectorAll('.availability-day').forEach((day) => {
    const checked = day.querySelectorAll('.avail-cell:checked');
    if (!checked.length) unavailability.push({ workDate: day.dataset.date, reason: day.querySelector('.leave-reason').value.trim() || null });
    else checked.forEach((cell) => availability.push({ workDate: day.dataset.date, shiftId: Number(cell.value) }));
  });
  const id = employee.context.period.id;
  employee.saving = true;
  $('#enroll-period').disabled = true;
  form.querySelector('fieldset').disabled = true;
  try {
    await API.saveEnrollment(id, { workTypes, maxShifts: $('#enroll-max').value === '' ? null : Number($('#enroll-max').value), availability, unavailability, note: $('#enroll-note').value, submit });
    toast(submit ? '报名已提交' : '草稿已保存');
    await loadEnrollment();
  } catch (err) {
    $('#enroll-error').textContent = employeeError(err);
    form.querySelector('fieldset').disabled = false;
  } finally {
    employee.saving = false;
    $('#enroll-period').disabled = false;
  }
}

// ------------------------------ 我的换班 ------------------------------

async function renderEmployeeSwaps() {
  const box = $('#swap-create-content');
  box.innerHTML = '<p class="empty-tip">正在加载我的班次…</p>';
  employee.candidates = [];
  await Promise.all([loadEmployeeAssignments(), loadEmployeeSwapLists()]);
}

async function loadEmployeeAssignments() {
  const box = $('#swap-create-content');
  try {
    const assignments = await API.myAssignments();
    if (!state.user) return;
    employee.assignments = assignments.filter((a) => a.periodStatus === 'published');
    if (!employee.assignments.length) {
      box.innerHTML = '<p class="empty-tip">暂无可换班的已发布班次。报名后请等待管理员发布排班。</p>';
      return;
    }
    box.innerHTML = `<form id="swap-create-form">
      <fieldset>
        <legend class="sr-only">发起换班</legend>
        <label class="field">我的班次<select id="swap-from" required><option value="">请选择要转出或互换的班次</option>${employee.assignments.map((a) => `<option value="${a.id}">${escapeHtml(a.periodName)} · ${escapeHtml(assignmentLabel(a))}</option>`).join('')}</select></label>
        <label class="field">换班方式<select id="swap-type"><option value="transfer">转班（请同事接班）</option><option value="exchange">互换（交换双方班次）</option></select></label>
        <div id="swap-candidates"><p class="form-help">先选择自己的班次，再选择同事。</p></div>
        <label class="field">给同事的留言<textarea id="swap-message" rows="2" maxlength="1000" placeholder="可选，说明换班原因"></textarea></label>
        <p id="swap-create-error" class="form-error" role="alert"></p>
        <button id="btn-swap-submit" class="btn-success" type="submit" disabled>发起申请</button>
      </fieldset>
    </form>`;
  } catch (err) { box.innerHTML = errorMarkup(err); }
}

async function loadSwapCandidates() {
  const id = $('#swap-from').value;
  const box = $('#swap-candidates');
  employee.candidates = [];
  $('#btn-swap-submit').disabled = true;
  $('#swap-create-error').textContent = '';
  if (!id) { box.innerHTML = '<p class="form-help">请先选择自己的班次。</p>'; return; }
  box.innerHTML = '<p class="form-help">正在查询同事及班次…</p>';
  try {
    const result = await API.swapCandidates(id);
    if ($('#swap-from')?.value !== id) return;
    employee.candidates = result.candidates;
    renderSwapCandidates();
  } catch (err) { if ($('#swap-from')?.value === id) box.innerHTML = errorMarkup(err); }
}

function renderSwapCandidates() {
  const exchange = $('#swap-type').value === 'exchange';
  const candidates = employee.candidates;
  $('#btn-swap-submit').disabled = true;
  $('#swap-candidates').innerHTML = candidates.length ? `
    <label class="field">${exchange ? '互换同事' : '接班同事'}<select id="swap-to-user" required><option value="">请选择同事</option>${candidates.map((c) => {
      const disabled = exchange ? !c.theirAssignments.length : !c.canTake;
      const reason = exchange ? (!c.theirAssignments.length ? '无可交换班次' : '') : c.problems.map((p) => p.label || p.message).join('、');
      return `<option value="${c.userId}" ${disabled ? 'disabled' : ''}>${escapeHtml(c.name)}（${escapeHtml(c.employeeNo)}）${reason ? ` · ${escapeHtml(reason)}` : ''}</option>`;
    }).join('')}</select></label>
    ${exchange ? '<p class="form-help">互换会同时校验双方约束，提交时如有冲突会说明原因。</p>' : ''}
    <div id="swap-target"></div>` : '<p class="empty-tip">该周期暂无已报名的同事可供选择。</p>';
}

function renderSwapTarget() {
  const candidate = employee.candidates.find((c) => c.userId === Number($('#swap-to-user').value));
  const exchange = $('#swap-type').value === 'exchange';
  $('#swap-target').innerHTML = exchange && candidate ? `<label class="field">对方的班次<select id="swap-to-assignment" required><option value="">请选择要交换的班次</option>${candidate.theirAssignments.map((a) => `<option value="${a.id}">${escapeHtml(assignmentLabel(a))}</option>`).join('')}</select></label>` : '';
  $('#btn-swap-submit').disabled = !candidate || exchange;
}

async function createEmployeeSwap(event) {
  event.preventDefault();
  if (employee.saving) return;
  const fromAssignmentId = Number($('#swap-from').value);
  const toUserId = Number($('#swap-to-user')?.value);
  const type = $('#swap-type').value;
  const toAssignmentId = Number($('#swap-to-assignment')?.value);
  if (!fromAssignmentId || !toUserId || (type === 'exchange' && !toAssignmentId)) return;
  employee.saving = true;
  const fieldset = event.target.querySelector('fieldset');
  const payload = { type, fromAssignmentId, toUserId, message: $('#swap-message').value.trim() };
  if (type === 'exchange') payload.toAssignmentId = toAssignmentId;
  fieldset.disabled = true;
  try {
    const result = await API.createSwap(payload);
    toast('申请已发起，等待同事确认');
    await Promise.all([renderEmployeeSwaps(), openEmployeeSwap(result.swap.id)]);
  } catch (err) {
    $('#swap-create-error').textContent = employeeError(err);
    fieldset.disabled = false;
  } finally { employee.saving = false; }
}

async function loadEmployeeSwapLists() {
  for (const [id, request] of [['swap-inbox', API.swapInbox], ['swap-mine', API.mySwaps]]) {
    const box = $(`#${id}`);
    box.innerHTML = '<p class="empty-tip">正在加载申请…</p>';
    try {
      const list = await request();
      if (!state.user) return;
      if (id === 'swap-inbox') $('#swap-inbox-count').textContent = list.length;
      box.innerHTML = list.map((s) => `<div class="swap-item employee-swap-item">
        <div><b>${escapeHtml(s.requesterName)} ${s.type === 'exchange' ? '⇄' : '→'} ${escapeHtml(s.toUserName)}</b>
          <p>${escapeHtml(assignmentLabel(s.fromAssign))}</p>
          ${s.toAssign ? `<p>互换：${escapeHtml(assignmentLabel(s.toAssign))}</p>` : ''}
          <span class="swap-status ${escapeHtml(s.status)}">${swapLabels[s.status] || escapeHtml(s.status)}</span>
        </div><button class="btn-ghost" data-swap-id="${s.id}">查看详情${s.canAct ? ' / 处理' : ''}</button>
      </div>`).join('') || `<p class="empty-tip">${id === 'swap-inbox' ? '没有待你确认的申请。' : '还没有发起过换班。'}</p>`;
    } catch (err) { box.innerHTML = errorMarkup(err); }
  }
}

async function openEmployeeSwap(id) {
  const dialog = $('#swap-dialog');
  const box = $('#swap-detail-content');
  employee.detail = null;
  box.innerHTML = '<p class="empty-tip">正在加载换班详情…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const d = await API.swapDetail(id);
    if (!state.user || !dialog.open) return;
    employee.detail = d;
    const pending = d.swap.status === 'pending';
    const canDecide = pending && d.myDecision === 'pending';
    const canCancel = pending && d.swap.requesterId === state.user.id;
    box.innerHTML = `<p class="notice">${swapLabels[d.swap.status] || escapeHtml(d.swap.status)} · ${d.swap.type === 'exchange' ? '互换' : '转班'} #${d.swap.id}</p>
      <p class="detail-line">发起人：${escapeHtml(d.swap.requesterName)} → ${escapeHtml(d.swap.toUserName)}</p>
      <p class="detail-line">转出：${escapeHtml(assignmentLabel(d.fromAssignment))}</p>
      ${d.toAssignment ? `<p class="detail-line">互换：${escapeHtml(assignmentLabel(d.toAssignment))}</p>` : ''}
      <p class="detail-line">留言：${escapeHtml(d.swap.message || '无')}</p>
      <h3>参与者确认</h3><ul class="participant-list">${d.participants.map((p) => `<li>${escapeHtml(p.name)}${p.isMe ? '（我）' : ''}：${({ pending: '待确认', approved: '已同意', rejected: '已拒绝' })[p.status] || escapeHtml(p.status)}</li>`).join('')}</ul>
      ${d.liveProblems.length ? `<p class="form-error">${escapeHtml(d.liveProblems.map((p) => p.label || p.message).join('；'))}</p>` : ''}
      ${canDecide ? '<label class="field">拒绝原因（可选）<input id="swap-reject-reason" maxlength="200" placeholder="填写拒绝原因"></label>' : ''}
      <p id="swap-action-error" class="form-error" role="alert"></p>
      <div class="form-actions">${canDecide ? `<button class="btn-success" data-swap-action="confirm" ${d.canConfirm ? '' : 'disabled'}>同意换班</button><button class="btn-ghost" data-swap-action="reject">拒绝申请</button>` : ''}${canCancel ? '<button class="btn-ghost" data-swap-action="cancel">撤回申请</button>' : ''}</div>`;
  } catch (err) { box.innerHTML = errorMarkup(err); }
}

async function decideEmployeeSwap(action) {
  if (employee.acting || !employee.detail) return;
  if (action !== 'confirm' && !window.confirm(action === 'reject' ? '确认拒绝该申请？拒绝后申请将结束。' : '确认撤回该换班申请？')) return;
  employee.acting = true;
  const id = employee.detail.swap.id;
  const reason = $('#swap-reject-reason')?.value.trim() || null;
  $$('#swap-detail-content [data-swap-action]').forEach((b) => { b.disabled = true; });
  try {
    const result = await API.decideSwap(id, action, reason);
    toast(action === 'confirm' ? (result.applied ? '换班已生效' : '已同意，等待其他参与者确认') : action === 'reject' ? '已拒绝申请' : '申请已撤回');
    await Promise.all([renderEmployeeSwaps(), renderSchedule(), openEmployeeSwap(id)]);
  } catch (err) {
    await openEmployeeSwap(id);
    if ($('#swap-action-error')) $('#swap-action-error').textContent = employeeError(err);
  } finally { employee.acting = false; }
}

function bindEmployeeEvents() {
  $('#btn-enroll-refresh').addEventListener('click', () => { if (!employee.saving) renderEnrollment(); });
  $('#enroll-period').addEventListener('change', loadEnrollment);
  $('#enroll-content').addEventListener('submit', saveEmployeeEnrollment);
  $('#enroll-content').addEventListener('change', (event) => {
    const target = event.target;
    if (target.id === 'enroll-month') {
      employee.month = target.value;
      $$('.availability-day').forEach((day) => day.classList.toggle('hidden', day.dataset.date.slice(0, 7) !== target.value));
      return;
    }
    if (target.name === 'workType') {
      $(`[name="priority-${target.value}"]`).disabled = !target.checked;
      const role = $(`[name="role-${target.value}"]`);
      if (role) role.disabled = !target.checked;
    }
    const day = target.closest('.availability-day');
    if (!day) return;
    if (target.classList.contains('block-day')) day.querySelectorAll('.avail-cell').forEach((cell) => { cell.checked = !target.checked; });
    const blocked = !day.querySelector('.avail-cell:checked');
    day.querySelector('.block-day').checked = blocked;
    day.querySelector('.leave-reason').classList.toggle('hidden', !blocked);
  });
  $('#btn-swaps-refresh').addEventListener('click', () => { if (!employee.saving) renderEmployeeSwaps(); });
  $('#swap-create-content').addEventListener('submit', createEmployeeSwap);
  $('#swap-create-content').addEventListener('change', (event) => {
    if (event.target.id === 'swap-from') loadSwapCandidates();
    if (event.target.id === 'swap-type') renderSwapCandidates();
    if (event.target.id === 'swap-to-user') renderSwapTarget();
    if (event.target.id === 'swap-to-assignment') $('#btn-swap-submit').disabled = !event.target.value;
  });
  $('#tab-swaps').addEventListener('click', (event) => {
    const button = event.target.closest('[data-swap-id]');
    if (button) openEmployeeSwap(Number(button.dataset.swapId));
  });
  $('#swap-detail-content').addEventListener('click', (event) => {
    const button = event.target.closest('[data-swap-action]');
    if (button) decideEmployeeSwap(button.dataset.swapAction);
  });
  $('#btn-swap-close').addEventListener('click', () => $('#swap-dialog').close());
}
