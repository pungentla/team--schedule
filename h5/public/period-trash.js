'use strict';
const periodTrash = { request: 0, busy: false };
function resetPeriodTrash() {
  periodTrash.request++;
  $('#period-trash-dialog').close();
}
async function openPeriodTrash() {
  if (state.user?.role !== 'super_admin') return;
  const token = ++periodTrash.request;
  const box = $('#period-trash-content');
  box.textContent = '加载回收站…';
  if (!$('#period-trash-dialog').open) $('#period-trash-dialog').showModal();
  try {
    const periods = await API.deletedPeriods();
    if (token !== periodTrash.request || state.user?.role !== 'super_admin') return;
    box.innerHTML = periods.length ? periods.map((p) => `<article class="trash-period"><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.startDate)} 至 ${escapeHtml(p.endDate)} · ${periodLabels[p.status]}</p><p class="form-help">${escapeHtml(p.deletedByName || '未知人员')} 删除于 ${escapeHtml(new Date(p.deletedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</p><button type="button" class="btn-ghost" data-restore-period="${p.id}" data-period-name="${escapeHtml(p.name)}" data-period-status="${p.status}">恢复周期</button></article>`).join('') : '<p class="empty-tip">回收站为空</p>';
    box.insertAdjacentHTML('beforeend', '<p id="trash-error" class="form-error" role="alert"></p>');
  } catch (err) { if (token === periodTrash.request) box.innerHTML = errorMarkup(err); }
}
function bindPeriodTrashEvents() {
  document.addEventListener('click', (event) => { if (event.target.closest('[data-open-period-trash]')) openPeriodTrash(); });
  $('#btn-trash-close').addEventListener('click', () => { if (!periodTrash.busy) resetPeriodTrash(); });
  $('#period-trash-dialog').addEventListener('cancel', (event) => { if (periodTrash.busy) event.preventDefault(); else periodTrash.request++; });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-period], [data-restore-period]');
    if (!button || periodTrash.busy || !isAdminUser()) return;
    const restoring = button.hasAttribute('data-restore-period');
    if (restoring && state.user.role !== 'super_admin') return;
    const id = Number(restoring ? button.dataset.restorePeriod : button.dataset.deletePeriod);
    const period = restoring ? null : workConfig.periods.find((p) => p.id === id);
    if (!restoring && !period) return;
    const name = restoring ? button.dataset.periodName : period.name;
    const message = restoring
      ? `恢复「${name}」？${button.dataset.periodStatus === 'published' ? '原已发布排班会重新生效。' : '报名、需求和排班将恢复为删除前的状态。'}`
      : `删除「${name}」？该周期的排班、报名和换班将隐藏，仅超级管理员可以从回收站恢复。`;
    if (!window.confirm(message)) return;
    const actorId = state.user.id;
    periodTrash.busy = true; button.disabled = true;
    $('#btn-trash-close').disabled = true;
    try {
      const result = restoring ? await API.restorePeriod(id) : await API.deletePeriod(id);
      if (state.user?.id !== actorId) return;
      if (restoring) { state.period = result; flow.creating = false; flow.step = 'period'; }
      else if (state.period?.id === id) { state.period = null; flow.periodId = null; flow.preparation = null; }
      toast(restoring ? '周期已恢复' : '周期已移入回收站');
      if (restoring) resetPeriodTrash();
      await renderAdmin();
    } catch (err) {
      if (state.user?.id === actorId) $(restoring ? '#trash-error' : '#flow-error').textContent = employeeError(err);
    } finally {
      periodTrash.busy = false; button.disabled = false; $('#btn-trash-close').disabled = false;
    }
  });
}
