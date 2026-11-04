'use strict';

const workConfig = { periods: [], users: [], shifts: [], tab: 'worktypes', month: null, workTypeId: null };
const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function switchConfigTab(tab, load = true) {
  workConfig.tab = tab;
  $$('[data-config-tab]').forEach((button) => { button.setAttribute('aria-selected', String(button.dataset.configTab === tab)); });
  $$('.config-panel').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.configPanel !== tab));
  if (load && tab === 'accounts') renderAccounts();

}

function weeklyAssignmentRow(rule = {}, roles = false) {
  return `<div class="weekly-rule"><label class="field">星期<select data-weekday>${[1,2,3,4,5,6,0].map((day) => `<option value="${day}" ${rule.weekday === day ? 'selected' : ''}>${weekdayLabels[day]}</option>`).join('')}</select></label>
  <label class="field">班次<select data-shift required><option value="">选择班次</option>${workConfig.shifts.map((s) => `<option value="${s.id}" ${s.id === rule.shiftId ? 'selected' : ''} ${!s.active ? 'disabled' : ''}>${escapeHtml(s.name)}${s.active ? '' : '（停用）'}</option>`).join('')}</select></label>
  <label class="field">固定人员<select data-user required><option value="">选择人员</option>${workConfig.users.map((u) => `<option value="${u.id}" ${u.id === rule.userId ? 'selected' : ''} ${u.status !== 'active' ? 'disabled' : ''}>${escapeHtml(u.name)}（${escapeHtml(u.employeeNo)}）${u.role === 'employee' ? '' : ` · ${accountRoles[u.role]}`}${u.status === 'active' ? '' : '（停用）'}</option>`).join('')}</select></label>
  <label class="field">负责人角色<select data-duty-role required>${(roles ? ['primary','deputy'] : ['member']).map((role) => `<option value="${role}" ${role === rule.dutyRole ? 'selected' : ''}>${dutyRoleLabels[role]}</option>`).join('')}</select></label><button type="button" class="btn-ghost" data-remove-weekly>移除此人</button></div>`;
}

function workTypeFields(w = {}) {
  return `<label class="field">工作名称<input name="name" value="${escapeHtml(w.name || '')}" required maxlength="32"></label>
    <label class="field">工作说明<textarea name="description" rows="2" maxlength="200">${escapeHtml(w.description || '')}</textarea></label>
    <div class="row"><label>显示颜色 <input name="color" type="color" value="${/^#[a-f0-9]{6}$/i.test(w.color || '') ? w.color : '#4A90D9'}"></label><label>显示排序 <input name="sortOrder" type="number" min="0" max="999" value="${w.sortOrder || 0}" required></label></div>
    <label class="field checkbox-field"><input type="checkbox" name="requiresRoles" ${w.requiresRoles ? 'checked' : ''}> 区分主副负责人</label>
    <fieldset class="weekday-options"><legend>每周需要哪些天</legend>${[1, 2, 3, 4, 5, 6, 0].map((day) => `<label><input name="weekdays" type="checkbox" value="${day}" ${(w.weekdays || [0, 1, 2, 3, 4, 5, 6]).includes(day) ? 'checked' : ''}> ${weekdayLabels[day]}</label>`).join('')}</fieldset>
    <label class="field">默认每班人数<input name="defaultNeed" type="number" required min="0" max="99" value="${w.defaultNeed ?? (w.requiresRoles ? 2 : 1)}"></label>

    <fieldset><legend>长期固定人员 ${helpButton('fixed')}</legend><div class="weekly-rules">${(w.weeklyAssignments || []).map((rule) => weeklyAssignmentRow(rule, w.requiresRoles)).join('')}</div><button type="button" class="btn-ghost" data-add-weekly>＋ 添加固定人员</button></fieldset>
    ${w.id ? `<label class="field checkbox-field"><input type="checkbox" name="active" ${w.active ? 'checked' : ''}> 启用工作</label>` : ''}`;
}

function shiftFields(s = {}) {
  return `<label class="field">班次名称<input name="name" required maxlength="32" value="${escapeHtml(s.name || '')}"></label>
    <div class="row"><label>开始时间 <input name="startTime" type="time" required value="${escapeHtml(s.startTime || '08:00')}"></label><label>结束时间 <input name="endTime" type="time" required value="${escapeHtml(s.endTime || '14:00')}"></label><label>班次顺序 <input name="seq" type="number" required min="1" max="99" value="${s.seq || 1}"></label></div>
    ${s.id ? `<label class="field checkbox-field"><input name="active" type="checkbox" ${s.active ? 'checked' : ''}> 启用该班次</label>` : ''}`;
}

function periodFields(p = {}, { compact = false } = {}) {
  return `<label class="field">周期名称<input name="name" required maxlength="64" value="${escapeHtml(p.name || '')}"></label>
    <label class="field">周期长度<select name="duration" aria-label="周期长度">${[['custom', '自定义起止日期'], ['week', '一周'], ['month', '一个月'], ['bimonth', '双月（连续两个月）'], ['quarter', '一个季度'], ['halfyear', '半年'], ['year', '一年']].map(([value, label]) => `<option value="${value}" ${(p.id ? value === 'custom' : value === 'week') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <div class="row"><label>开始日期 <input name="startDate" type="date" required value="${escapeHtml(p.startDate || '')}"></label><label>结束日期 <input name="endDate" type="date" required value="${escapeHtml(p.endDate || '')}"></label></div>

    ${compact ? '<details><summary>排班规则（可选）</summary>' : ''}
    <div class="row"><label>每人每天最多班次 <input name="maxShiftsPerDay" type="number" required min="1" max="5" value="${p.maxShiftsPerDay || 1}"></label><label>每人每周最多班次 <input name="maxShiftsPerWeek" type="number" required min="1" max="21" value="${p.maxShiftsPerWeek || 5}"></label></div>
    <label class="field checkbox-field"><input name="forbidConsecutive" type="checkbox" ${p.forbidConsecutive !== false ? 'checked' : ''}> 禁止同一天连续班次</label>${compact ? '</details>' : ''}`;
}

function renderPeriodConfig() {
  const period = workConfig.periods.find((p) => String(p.id) === $('#requirements-period').value);
  if (!period) return;
  const locked = ['published', 'archived'].includes(period.status);
  const transitions = { draft: ['enrolling', 'archived'], enrolling: ['scheduling', 'draft', 'archived'], scheduling: ['enrolling', 'archived'], published: ['archived'], archived: [] };
  $('#period-config').innerHTML = `<details><summary>当前周期设置：${escapeHtml(period.name)} · ${periodLabels[period.status]}</summary>
    <form id="period-edit-form" data-period-id="${period.id}"><fieldset ${locked ? 'disabled' : ''}>${periodFields(period)}<p class="form-error" role="alert"></p><button type="submit" class="btn-ghost">保存周期设置</button></fieldset></form><details><summary>更多周期操作</summary><form id="period-status-form" data-period-id="${period.id}" class="row"><label>周期状态<select name="status">${[period.status, ...transitions[period.status]].map((s) => `<option value="${s}">${periodLabels[s]}</option>`).join('')}</select></label><p class="form-help">归档后仅供查看；开放报名通常在「参与人员」步骤完成。</p><p class="form-error" role="alert"></p><button class="btn-ghost" type="submit" ${period.status === 'archived' ? 'disabled' : ''}>更新周期状态</button></form></details></details>
    <button class="btn-success" type="button" data-flow-step="requirements">下一步：确认需求</button>`;

}

async function renderWorkConfig() {
  if (!isAdminUser()) return;
  const box = $('#worktype-config');
  box.innerHTML = '<p class="empty-tip">正在加载工作配置…</p>';
  try {
    const [workTypes, shifts, users] = await Promise.all([API.workTypes(), API.shifts(), API.adminUsers()]);
    workConfig.users = users; workConfig.shifts = shifts;
    if (!isAdminUser()) return;
    box.innerHTML = `<details><summary>＋ 新增工作类型</summary><form data-worktype-id="">${workTypeFields()}<p class="form-error" role="alert"></p><button class="btn-success" type="submit">新增工作</button></form></details>` + workTypes.map((w) => `<details><summary>${escapeHtml(w.name)} · ${w.active ? '已启用' : '已停用'}${w.requiresRoles ? ' · 至少 1 主 + 1 副' : ''}</summary><form data-worktype-id="${w.id}">${workTypeFields(w)}<p class="form-error" role="alert"></p><button class="btn-ghost" type="submit">保存工作设置</button></form></details>`).join('');
    $('#shift-config').innerHTML = `<details><summary>＋ 新增班次</summary><form data-shift-id="">${shiftFields({ seq: Math.max(0, ...shifts.map((s) => s.seq)) + 1 })}<p class="form-error" role="alert"></p><button class="btn-success" type="submit">新增班次</button></form></details>` + shifts.map((s) => `<details><summary>${escapeHtml(s.name)} ${escapeHtml(s.startTime)}–${escapeHtml(s.endTime)} · ${s.active ? '已启用' : '已停用'}</summary><form data-shift-id="${s.id}">${shiftFields(s)}<p class="form-error" role="alert"></p><button class="btn-ghost" type="submit">保存班次设置</button></form></details>`).join('');
    switchConfigTab(workConfig.tab, false);
    if (workConfig.tab === 'accounts') await renderAccounts();
  } catch (err) { box.innerHTML = errorMarkup(err); }
}

async function renderRequirements() {
  const id = $('#requirements-period').value;
  const box = $('#requirements-config');
  box.innerHTML = '<p class="empty-tip">正在加载需求人数…</p>';
  try {
    const data = await API.requirements(id);
    if (!isAdminUser() || $('#requirements-period').value !== id) return;
    const locked = ['published', 'archived'].includes(data.period.status);
    if (workConfig.requirementsPeriodId !== id) { workConfig.requirementsPeriodId = id; workConfig.workTypeId = null; workConfig.month = null; }
    const months = [...new Set(data.dates.map((d) => d.workDate.slice(0, 7)))];
    const month = months.includes(workConfig.month) ? workConfig.month : months[0];
    workConfig.month = month;
    const firstNeeded = data.workTypes.find((w) => data.dates.some((d) => d.shifts.some((s) => s.requirements.some((r) => r.workTypeId === w.id && r.needCount > 0)))) || data.workTypes[0];
    const defaultWork = window.matchMedia('(max-width: 640px)').matches && firstNeeded ? String(firstNeeded.id) : 'all';
    const workTypeId = data.workTypes.some((w) => String(w.id) === workConfig.workTypeId) || workConfig.workTypeId === 'all' ? workConfig.workTypeId : defaultWork;
    workConfig.workTypeId = workTypeId;
    box.innerHTML = `${locked ? '<p class="notice">已发布或归档，仅供查看。</p>' : ''}<p class="notice">${data.dates.length} 天 · ${data.shifts.length} 个班次 · 需求 <b>${data.totalNeeded}</b> 人次</p>

      <div class="form-actions">${!data.dates.length && !locked ? '<button id="btn-initialize-period" class="btn-success" type="button">按基础设置初始化需求</button>' : ''}<button id="btn-apply-work-rules" class="btn-ghost" ${locked || !data.dates.length ? 'disabled' : ''}>重新按默认规则填充</button></div>
      <div class="row demand-filters"><label>查看月份<select id="requirements-month">${months.map((m) => `<option value="${m}" ${m === month ? 'selected' : ''}>${m}</option>`).join('')}</select></label><label>工作类型<select id="requirements-worktype"><option value="all">全部工作</option>${data.workTypes.map((w) => `<option value="${w.id}" ${String(w.id) === workTypeId ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('')}</select></label></div>
      <form id="requirements-form" data-period-id="${id}"><fieldset ${locked ? 'disabled' : ''}>
        <legend class="sr-only">各班次需求人数</legend><div class="requirements-scroll"><table class="requirements-table">
          <thead><tr><th>日期 / 班次</th>${data.workTypes.map((w) => `<th data-worktype-column="${w.id}" class="${workTypeId !== 'all' && workTypeId !== String(w.id) ? 'hidden' : ''}">${escapeHtml(w.name)}${w.requiresRoles ? '<br><small>至少 1 主 + 1 副</small>' : ''}</th>`).join('')}</tr></thead>
          <tbody>${data.dates.map((day) => day.shifts.map((shift) => `<tr data-demand-month="${day.workDate.slice(0, 7)}" class="${day.workDate.slice(0, 7) === month ? '' : 'hidden'}"><th>${escapeHtml(day.workDate)}<br>${escapeHtml(shift.shiftName)}</th>${shift.requirements.map((r) => `<td data-worktype-column="${r.workTypeId}" class="${workTypeId !== 'all' && workTypeId !== String(r.workTypeId) ? 'hidden' : ''}"><input type="number" min="0" max="99" step="1" value="${r.needCount}" ${r.allowed === false ? 'disabled title="该工作在当天不开放"' : ''} data-original="${r.needCount}" data-date="${escapeHtml(day.workDate)}" data-shift-id="${shift.shiftId}" data-worktype-id="${r.workTypeId}" aria-label="${escapeHtml(day.workDate)}${escapeHtml(shift.shiftName)}${escapeHtml(r.workTypeName)}需求人数"></td>`).join('')}</tr>`).join('')).join('')}</tbody>
        </table></div><p class="form-error" role="alert" id="requirements-error"></p><button class="btn-success" type="submit" ${data.dates.length ? '' : 'disabled'}>保存需求，下一步</button></fieldset></form>${locked ? '<button class="btn-success" data-flow-step="people">下一步：查看参与人员</button>' : ''}`;
  } catch (err) { if ($('#requirements-period').value === id) box.innerHTML = errorMarkup(err); }
}

function bindWorkConfigEvents() {
  $('#worktype-config').addEventListener('click', (event) => {
    if (event.target.closest('[data-remove-weekly]')) event.target.closest('.weekly-rule').remove();
    if (event.target.closest('[data-add-weekly]')) {
      const form = event.target.closest('form');
      form.querySelector('.weekly-rules').insertAdjacentHTML('beforeend', weeklyAssignmentRow({}, form.elements.requiresRoles.checked));
    }
  });
  $('#worktype-config').addEventListener('change', (event) => {
    if (event.target.name !== 'requiresRoles') return;
    const roles = event.target.checked ? ['primary', 'deputy'] : ['member'];
    event.target.form.querySelectorAll('[data-duty-role]').forEach((select) => { select.innerHTML = roles.map((role) => `<option value="${role}">${dutyRoleLabels[role]}</option>`).join(''); });
  });
  $$('.config-nav button').forEach((button) => button.addEventListener('click', () => switchConfigTab(button.dataset.configTab)));
  document.addEventListener('change', async (event) => {
    const input = event.target;
    if (input.name === 'requiresRoles') {
      const number = input.form.elements.defaultNeed;
      if (input.checked && number.value === '1') number.value = '2';
    }
    if (input.id === 'requirements-month') {
      workConfig.month = input.value;
      $$('[data-demand-month]').forEach((row) => row.classList.toggle('hidden', row.dataset.demandMonth !== input.value));
    }
    if (input.id === 'requirements-worktype') {
      workConfig.workTypeId = input.value;
      $$('[data-worktype-column]').forEach((cell) => cell.classList.toggle('hidden', input.value !== 'all' && cell.dataset.worktypeColumn !== input.value));
    }
    const form = input.closest('#period-create-form, #period-edit-form');
    if (!form) return;
    if (input.name === 'endDate') { form.elements.duration.value = 'custom'; return; }
    if (!['startDate', 'duration'].includes(input.name)) return;
    const start = form.elements.startDate.value;
    const duration = form.elements.duration.value;
    if (!start || duration === 'custom') return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const range = await API.periodRange(start, duration);
      if (form.isConnected && form.elements.startDate.value === start && form.elements.duration.value === duration) form.elements.endDate.value = range.endDate;
    } catch (err) { form.querySelector('.form-error').textContent = employeeError(err); }
    finally { button.disabled = false; }
  });
  $('#btn-config-refresh').addEventListener('click', renderWorkConfig);
  $('#worktype-config').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    form.querySelector('.form-error').textContent = '';
    try {
      const e = form.elements;
      const body = { name: e.name.value.trim(), description: e.description.value.trim(), color: e.color.value, sortOrder: Number(e.sortOrder.value), requiresRoles: e.requiresRoles.checked, defaultNeed: Number(e.defaultNeed.value), weekdays: Array.from(form.querySelectorAll('[name="weekdays"]:checked')).map((input) => Number(input.value)) };
      body.weeklyAssignments = Array.from(form.querySelectorAll('.weekly-rule')).map((row) => ({ weekday: Number(row.querySelector('[data-weekday]').value), shiftId: Number(row.querySelector('[data-shift]').value), userId: Number(row.querySelector('[data-user]').value), dutyRole: row.querySelector('[data-duty-role]').value }));
      if (form.dataset.worktypeId) { body.active = e.active.checked; await API.updateWorkType(Number(form.dataset.worktypeId), body); }
      else { body.code = `WT_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; await API.createWorkType(body); }
      toast('工作配置已保存');
      await renderWorkConfig();
    } catch (err) { form.querySelector('.form-error').textContent = employeeError(err); }
    finally { button.disabled = false; }
  });
  $('#shift-config').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    const e = form.elements;
    const body = { name: e.name.value.trim(), startTime: e.startTime.value, endTime: e.endTime.value, seq: Number(e.seq.value) };
    if (form.dataset.shiftId) body.active = e.active.checked;
    else body.code = `SHIFT_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    try { await API.saveShift(Number(form.dataset.shiftId) || null, body); toast('班次设置已保存'); await renderWorkConfig(); }
    catch (err) { form.querySelector('.form-error').textContent = employeeError(err); }
    finally { button.disabled = false; }
  });
  $('#requirements-config').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const fieldset = form.querySelector('fieldset');
    if (fieldset.disabled) return;
    const items = Array.from(form.querySelectorAll('input[data-worktype-id]')).filter((input) => input.value !== input.dataset.original).map((input) => ({ workDate: input.dataset.date, shiftId: Number(input.dataset.shiftId), workTypeId: Number(input.dataset.worktypeId), needCount: Number(input.value) }));
    if (!items.length) return continueFromRequirements();
    fieldset.disabled = true;
    $('#requirements-period').disabled = true;
    try {
      await API.saveRequirements(Number(form.dataset.periodId), items);
      form.querySelectorAll('input[data-worktype-id]').forEach((input) => { input.dataset.original = input.value; });
      toast('需求已保存');
      await continueFromRequirements();
    } catch (err) { $('#requirements-error').textContent = employeeError(err); fieldset.disabled = false; }
    finally { fieldset.disabled = false; $('#requirements-period').disabled = false; }
  });
}
