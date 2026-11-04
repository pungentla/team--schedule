'use strict';
const flow = { step: null, periodId: null, preparation: null, creating: false, beforeCreateStep: null, request: 0 };
const flowLabels = { period: '设置周期', requirements: '确认需求', people: '参与人员', generate: '生成发布' };
function confirmWorkflowLeave() {
  const form = $('#requirements-form');
  if (!form || form.querySelector('fieldset')?.disabled || form.dataset.periodId !== String(state.period?.id)) return true;
  const dirty = Array.from(form.querySelectorAll('input[data-original]')).filter((input) => input.value !== input.dataset.original);
  if (!dirty.length) return true;
  if (!window.confirm('需求人数尚未保存。放弃这些修改并继续？')) return false;
  dirty.forEach((input) => { input.value = input.dataset.original; });
  return true;
}
function resetWorkflow() {
  flow.step = null; flow.periodId = null; flow.preparation = null; flow.creating = false; flow.beforeCreateStep = null; flow.request++;
  $('#requirements-period').innerHTML = '';
}
function showWorkflowStep(step) {
  flow.step = step;
  $('.workflow-heading').classList.toggle('hidden', flow.creating);
  $('#period-create').classList.toggle('hidden', !flow.creating);
  $('#period-config').classList.toggle('hidden', flow.creating);
  $('#btn-flow-cancel-create').classList.toggle('hidden', !flow.creating);
  $('#flow-period-title').textContent = flow.creating ? '新建排班周期' : '1. 设置周期';
  $('#flow-period-intro').textContent = flow.creating ? '选择本次工作、班次和时间。' : '确认周期后设置需求。';
  $$('[data-flow-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.flowPanel !== step));
  $$('.workflow-steps [data-flow-step]').forEach((button) => button.setAttribute('aria-current', button.dataset.flowStep === step ? 'step' : 'false'));
}
function flowAction(blocker) {
  return blocker.configTab ? `<button type="button" class="btn-ghost" data-flow-config="${blocker.configTab}">设置${blocker.configTab === 'shifts' ? '班次' : '工作'}</button>` : `<button type="button" class="btn-ghost" data-flow-step="${blocker.step}">前往${flowLabels[blocker.step]}</button>`;
}
function renderWorkflowPreparation() {
  const p = flow.preparation;
  $('#btn-gen').disabled = !p?.canGenerate;
  $('#btn-regen').disabled = !p?.canGenerate;
  $('#btn-adjust-draft').disabled = !p?.draftRunId;
  $('#btn-adjust-published').disabled = !p?.publishedRunId || p?.period.status === 'archived';
  if (!p) {
    $('#flow-progress').textContent = '先创建排班周期。';
    $('#generation-readiness').innerHTML = '<p class="form-help">请先完成周期设置。</p>';
    $('#flow-participants').innerHTML = '<p class="form-help">创建周期并确认需求后，在这里查看参与人员。</p>';
    return;
  }
  $$('.workflow-steps [data-flow-step]').forEach((button) => { button.classList.toggle('is-complete', ({ period: true, requirements: p.totalNeeded > 0, people: p.participants.length > 0, generate: !!p.publishedRunId })[button.dataset.flowStep]); });
  const issue = p.blockers[0];
  $('#flow-progress').innerHTML = issue ? `${escapeHtml(issue.message)} ${issue.configTab ? flowAction(issue) : ''}` : p.draftRunId ? `草稿 #${p.draftRunId} 待检查发布，当前共有 ${p.totalNeeded} 人次需求。` : p.publishedRunId ? '本周期已发布，可继续报名、调班或重排。' : `需求 ${p.totalNeeded} 人次，${p.participants.length} 人参与。可以生成草稿，检查后再发布。`;
  $('#generation-readiness').innerHTML = p.canGenerate
    ? `<p class="notice">已就绪：需求 ${p.totalNeeded} 人次 · 参与 ${p.participants.length} 人。</p><div class="form-actions"><button class="btn-ghost" data-flow-step="requirements">返回查看需求</button><button class="btn-ghost" data-flow-step="people">返回查看人员</button></div>`
    : `<h3>待完成</h3>${p.blockers.map((b) => `<div class="flow-blocker"><p>${escapeHtml(b.message)}</p>${p.period.status === 'archived' ? '' : flowAction(b)}</div>`).join('')}`;
  const locked = p.period.status === 'archived';
  $('#flow-participants').innerHTML = `<p class="notice">需求 ${p.totalNeeded} 人次 · <b>${p.participants.length}</b> 人参与</p>
    <p class="form-help">固定 ${p.fixedCount} 人 · 本期报名 ${p.submittedCount} 人</p>
    ${p.participants.length ? `<details><summary>人员名单</summary><ul class="participant-list">${p.participants.map((u) => `<li>${escapeHtml(u.name)}（${escapeHtml(u.employeeNo)}） · ${[u.hasFixed ? '长期固定' : '', u.hasSubmitted ? '本期已报名' : ''].filter(Boolean).join('、')}${u.maxShifts === 0 ? ' · 本期不接班' : ''}</li>`).join('')}</ul></details>` : '<p class="form-help">暂无参与人员。</p>'}
    <div class="form-actions">${!locked ? '<button type="button" class="btn-success" id="btn-admin-enroll">代报名</button>' : ''}<button class="btn-ghost" id="btn-flow-people-refresh">刷新</button></div>
    ${!locked ? `<details class="participation-options"><summary>固定名单 / 本人报名</summary><div class="form-actions"><button class="btn-ghost" data-flow-config="worktypes">配置固定人员</button>${p.period.status === 'draft' ? '<button id="btn-flow-enroll" class="btn-ghost" ' + (!p.totalNeeded ? 'disabled' : '') + '>开放本人报名</button>' : '<span class="form-help">已开放，可在「我的报名」中提交。</span>'}</div></details>` : ''}

    <div class="form-actions"><button class="btn-ghost" data-flow-step="requirements">上一步：确认需求</button><button class="btn-success" data-flow-step="generate" ${!p.canGenerate && !locked ? 'disabled' : ''}>下一步：生成与发布</button></div>`;
}
async function refreshWorkflowPreparation() {
  if (!state.period) return null;
  const periodId = state.period.id;
  try {
    const p = await API.periodPreparation(periodId);
    if (!isAdminUser() || state.period?.id !== periodId) return null;
    flow.preparation = p;
    state.period = p.period;
    renderWorkflowPreparation();
    return p;
  } catch (err) { flow.preparation = null; renderWorkflowPreparation(); $('#flow-error').textContent = employeeError(err); return null; }
}
function periodScopeFields(works, shifts) {
  return `<fieldset class="period-scope"><legend>本次工作（至少一项）</legend><div class="scope-options">${works.filter((w) => w.active).map((w) => `<label><input type="checkbox" name="workTypeIds" value="${w.id}"><span>${escapeHtml(w.name)}${w.requiresRoles ? '<small>需主副负责人</small>' : ''}</span></label>`).join('')}</div></fieldset>
    <fieldset class="period-scope"><legend>本次班次（至少一项）</legend><div class="scope-options">${shifts.filter((s) => s.active).map((s) => `<label><input type="checkbox" name="shiftIds" value="${s.id}"><span>${escapeHtml(s.name)}<small>${escapeHtml(s.startTime)}–${escapeHtml(s.endTime)}</small></span></label>`).join('')}</div></fieldset>
    <p id="flow-scope-summary" class="form-help" aria-live="polite">尚未选择工作和班次。</p>`;
}
async function renderWorkflow() {
  if (!isAdminUser()) return;
  const token = ++flow.request;
  $('#flow-error').textContent = '';
  $('#btn-period-trash').classList.toggle('hidden', state.user?.role !== 'super_admin');
  $('#btn-flow-delete').disabled = true;
  $('#btn-flow-delete').removeAttribute('data-delete-period');
  $('#btn-gen').disabled = true;
  try {
    const [periods, shifts, works] = await Promise.all([API.listPeriods(), API.shifts(), API.workTypes()]);
    if (!isAdminUser() || token !== flow.request) return;
    workConfig.periods = periods;
    const selected = periods.find((p) => p.id === state.period?.id) || periods.find((p) => p.status !== 'archived') || periods[0];
    state.period = selected || null;
    $('#period-recycle-empty').classList.toggle('hidden', !!selected || state.user?.role !== 'super_admin');
    $('#btn-flow-delete').disabled = !selected;
    if (selected) $('#btn-flow-delete').dataset.deletePeriod = selected.id;
    if (!selected) flow.creating = true;
    const select = $('#requirements-period');
    select.innerHTML = periods.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}（${periodLabels[p.status]}）</option>`).join('');
    select.disabled = !selected;
    if (selected) select.value = selected.id;
    $('#flow-period-status').textContent = selected ? `${selected.startDate} 至 ${selected.endDate} · ${periodLabels[selected.status]}` : '还没有排班周期';
    const missing = [!works.some((w) => w.active) ? '工作类型' : '', !shifts.some((s) => s.active) ? '班次' : ''].filter(Boolean);
    $('#period-create').innerHTML = `${missing.length ? `<p class="notice">创建前先设置：${missing.join('、')}。${!works.some((w) => w.active) ? '<button class="btn-ghost" data-flow-config="worktypes">设置工作</button>' : ''}${!shifts.some((s) => s.active) ? '<button class="btn-ghost" data-flow-config="shifts">设置班次</button>' : ''}</p>` : ''}<form id="period-create-form">${periodFields({}, { compact: true })}${periodScopeFields(works, shifts)}<p class="form-error" role="alert"></p><button class="btn-success" type="submit" ${missing.length ? 'disabled' : ''}>创建并确认需求</button></form>`;
    $('#period-config').innerHTML = '';
    flow.preparation = null;
    if (selected) {
      renderPeriodConfig();
      if (!flow.creating) await refreshWorkflowPreparation();
      if (token !== flow.request) return;
      if (flow.periodId !== selected.id) { flow.periodId = selected.id; flow.step = flow.preparation?.nextStep || 'period'; }
    } else { flow.step = 'period'; renderWorkflowPreparation(); }
    showWorkflowStep(flow.creating ? 'period' : flow.step || 'period');
    if (!flow.creating && flow.step === 'requirements' && selected) await renderRequirements();
  } catch (err) { $('#flow-error').textContent = employeeError(err); }
}
async function openWorkflow(step) {
  if (!confirmWorkflowLeave()) return;
  switchTab('admin');
  if (!flow.preparation || flow.periodId !== state.period?.id) await renderAdmin();
  if (step !== 'period' && !state.period) step = 'period';
  flow.creating = false;
  showWorkflowStep(step);
  if (step === 'requirements' && state.period) await renderRequirements();
  $('#tab-admin').scrollIntoView({ block: 'start' });
}
async function continueFromRequirements() {
  const p = await refreshWorkflowPreparation();
  if (!p) return;
  if (!p.totalNeeded || p.blockers.some((b) => b.step === 'requirements')) {
    $('#requirements-error').textContent = p.blockers.find((b) => b.step === 'requirements')?.message || '请至少为一个班次填写需求人数。';
    return;
  }
  showWorkflowStep('people');
  $('#tab-admin').scrollIntoView({ block: 'start' });
}
function bindWorkflowEvents() {
  $('#period-create').addEventListener('change', (event) => {
    if (!['workTypeIds', 'shiftIds'].includes(event.target.name)) return;
    const form = event.target.form;
    const works = form.querySelectorAll('[name="workTypeIds"]:checked').length;
    const shifts = form.querySelectorAll('[name="shiftIds"]:checked').length;
    $('#flow-scope-summary').textContent = `已选 ${works} 项工作、${shifts} 个班次。`;
    const error = form.querySelector('.form-error');
    if (works && shifts && error.textContent === '请至少选择一项工作和一个班次。') error.textContent = '';
  });
  $('#requirements-period').addEventListener('change', async (event) => {
    if (!confirmWorkflowLeave()) { event.target.value = state.period.id; return; }
    state.period = workConfig.periods.find((p) => String(p.id) === event.target.value);
    flow.creating = false; state.lastRunId = null;
    await renderSchedule(); await renderAdmin();
  });
  $('#tab-admin').addEventListener('submit', async (event) => {
    const form = event.target;
    if (!['period-create-form', 'period-edit-form', 'period-status-form'].includes(form.id)) return;
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const e = form.elements;
      if (form.id === 'period-status-form') {
        state.period = await API.updatePeriod(Number(form.dataset.periodId), { status: e.status.value });
        await renderAdmin(); toast('周期状态已更新'); return;
      }
      const body = { name: e.name.value.trim(), startDate: e.startDate.value, endDate: e.endDate.value, maxShiftsPerDay: Number(e.maxShiftsPerDay.value), maxShiftsPerWeek: Number(e.maxShiftsPerWeek.value), forbidConsecutive: e.forbidConsecutive.checked };
      const creating = form.id === 'period-create-form';
      if (creating) {
        body.workTypeIds = Array.from(form.querySelectorAll('[name="workTypeIds"]:checked')).map((el) => Number(el.value));
        body.shiftIds = Array.from(form.querySelectorAll('[name="shiftIds"]:checked')).map((el) => Number(el.value));
        if (!body.workTypeIds.length || !body.shiftIds.length) {
          form.querySelector('.form-error').textContent = '请至少选择一项工作和一个班次。';
          form.querySelector(!body.workTypeIds.length ? '[name="workTypeIds"]' : '[name="shiftIds"]')?.focus();
          return;
        }
      }
      state.period = creating ? await API.createPeriod({ ...body, initializeRequirements: true }) : await API.updatePeriod(Number(form.dataset.periodId), body);
      flow.creating = false; flow.periodId = state.period.id; flow.step = 'requirements';
      await renderSchedule(); await renderAdmin();
      if (!creating) toast('周期已保存，请确认需求');
      $('#tab-admin').scrollIntoView({ block: 'start' });
    } catch (err) { form.querySelector('.form-error').textContent = employeeError(err); }
    finally { button.disabled = false; }
  });
  document.addEventListener('click', async (event) => {
    const config = event.target.closest('[data-flow-config]');
    const step = event.target.closest('[data-flow-step]');
    const button = event.target.closest('#btn-flow-new, #btn-flow-cancel-create, #btn-flow-refresh, #btn-flow-people-refresh, #btn-flow-enroll, #btn-initialize-period, #btn-apply-work-rules, [data-return-workflow]');
    if (step && !step.disabled) return openWorkflow(step.dataset.flowStep);
    if (config) { if (!confirmWorkflowLeave()) return; switchTab('config'); await renderWorkConfig(); switchConfigTab(config.dataset.flowConfig); $('#tab-config').scrollIntoView({ block: 'start' }); return; }
    if (!button || button.disabled) return;
    if (!confirmWorkflowLeave()) return;
    if (button.id === 'btn-flow-new') { flow.beforeCreateStep = flow.step; flow.creating = true; showWorkflowStep('period'); await renderWorkflow(); $('#tab-admin').scrollIntoView({ block: 'start' }); return; }
    if (button.id === 'btn-flow-cancel-create') {
      flow.creating = false; flow.step = flow.beforeCreateStep || flow.preparation?.nextStep || 'period';
      if (!state.period) { switchTab('schedule'); return; }
      await renderWorkflow(); $('#tab-admin').scrollIntoView({ block: 'start' }); return;
    }
    if (button.hasAttribute('data-return-workflow')) { await renderAdmin(); await openWorkflow(flow.step || flow.preparation?.nextStep || 'period'); return; }
    button.disabled = true;
    try {
      if (button.id === 'btn-flow-enroll') { await API.updatePeriod(state.period.id, { status: 'enrolling' }); toast('已开放报名，管理员和员工均可选择本周期'); }
      if (button.id === 'btn-initialize-period') { await API.preparePeriod(state.period.id); toast('需求已按基础设置准备好'); }
      if (button.id === 'btn-apply-work-rules') {
        if (!window.confirm('将按工作日和默认人数重新填充，覆盖本周期的手工人数。继续？')) return;
        await API.applyWorkRules(state.period.id); toast('默认人数已填入');
      }
      await renderAdmin();
    } catch (err) { $('#flow-error').textContent = employeeError(err); }
    finally { button.disabled = false; }
  });
}
