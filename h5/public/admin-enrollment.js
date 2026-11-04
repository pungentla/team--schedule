'use strict';
const proxyEnrollment = { periodId: null, data: null, request: 0, saving: false };
function resetAdminEnrollment() {
  proxyEnrollment.request++; proxyEnrollment.data = null;
  $('#admin-enroll-dialog').close();
}
async function openAdminEnrollment() {
  if (!state.period || !isAdminUser()) return;
  const period = state.period;
  const token = ++proxyEnrollment.request;
  proxyEnrollment.periodId = period.id; proxyEnrollment.data = null;
  $('#admin-enroll-content').innerHTML = '<p class="form-help">加载人员…</p>';
  $('#admin-enroll-dialog').showModal();
  try {
    const users = (await API.adminUsers()).filter((u) => u.status === 'active');
    if (token !== proxyEnrollment.request || !isAdminUser()) return;
    $('#admin-enroll-content').innerHTML = `<p class="form-help">${escapeHtml(period.name)}</p><label class="field">人员<select id="admin-enroll-user"><option value="">选择人员</option>${users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}（${escapeHtml(u.employeeNo)}） · ${accountRoles[u.role]}</option>`).join('')}</select></label><div id="admin-enroll-fields"><p class="form-help">选择人员后设置工作和角色。</p></div>`;
  } catch (err) { $('#admin-enroll-content').innerHTML = errorMarkup(err); }
}
async function loadAdminEnrollment() {
  const userId = Number($('#admin-enroll-user').value);
  const token = ++proxyEnrollment.request;
  proxyEnrollment.data = null;
  const box = $('#admin-enroll-fields');
  if (!userId) { box.textContent = ''; return; }
  box.textContent = '加载报名…';
  try {
    const data = await API.adminEnrollment(proxyEnrollment.periodId, userId);
    if (token !== proxyEnrollment.request) return;
    proxyEnrollment.data = data;
    const selected = new Map(data.enrollment.workTypes.map((w) => [w.workTypeId, w]));
    const locked = ['published', 'archived'].includes(data.context.period.status);
    box.innerHTML = `${locked ? '<p class="notice">本周期已发布或归档，不能修改报名。</p>' : ''}<form id="admin-enrollment-form"><fieldset ${locked ? 'disabled' : ''}><legend class="sr-only">代报名工作和角色</legend><p class="form-help">${data.enrollment.exists ? '更新本周期报名' : '新增本周期报名'}${data.enrollment.maxShifts === 0 ? ' · 个人上限为 0，暂不接班' : ''}</p><div class="worktype-options">${data.context.workTypes.map((w) => `<div class="worktype-option"><label><input name="workTypeIds" type="checkbox" value="${w.id}" ${selected.has(w.id) ? 'checked' : ''}> ${escapeHtml(w.name)}</label>${w.requiresRoles ? `<label class="field">角色<select name="duty-${w.id}" required ${selected.has(w.id) ? '' : 'disabled'}><option value="">选择主副角色</option>${['primary','deputy','both'].map((role) => `<option value="${role}" ${selected.get(w.id)?.dutyRole === role ? 'selected' : ''}>${dutyRoleLabels[role]}</option>`).join('')}</select></label>` : ''}</div>`).join('')}</div><p class="form-help">保留原有请假与个人上限。${state.draftSchedule?.run ? '提交后需重新生成草稿。' : ''}</p><p id="admin-enroll-error" class="form-error" role="alert"></p><button type="submit" class="btn-success">提交代报名</button></fieldset></form>`;
  } catch (err) { box.innerHTML = errorMarkup(err); }
}
function bindAdminEnrollmentEvents() {
  document.addEventListener('click', (event) => { if (event.target.closest('#btn-admin-enroll')) openAdminEnrollment(); });
  $('#btn-admin-enroll-close').addEventListener('click', () => { if (!proxyEnrollment.saving) resetAdminEnrollment(); });
  $('#admin-enroll-content').addEventListener('change', (event) => {
    if (event.target.id === 'admin-enroll-user') return loadAdminEnrollment();
    if (event.target.name === 'workTypeIds') {
      const role = event.target.form.elements[`duty-${event.target.value}`];
      if (role) role.disabled = !event.target.checked;
    }
  });
  $('#admin-enroll-content').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (proxyEnrollment.saving || !proxyEnrollment.data) return;
    const form = event.target;
    const previous = new Map(proxyEnrollment.data.enrollment.workTypes.map((w) => [w.workTypeId, w]));
    const workTypes = Array.from(form.querySelectorAll('[name="workTypeIds"]:checked')).map((el) => ({ workTypeId: Number(el.value), priority: previous.get(Number(el.value))?.priority || 1, dutyRole: form.elements[`duty-${el.value}`]?.value || 'member' }));
    if (!workTypes.length) { $('#admin-enroll-error').textContent = '至少选择一项工作。'; return; }
    const periodId = proxyEnrollment.periodId, userId = proxyEnrollment.data.user.id;
    const fieldset = form.querySelector('fieldset');
    proxyEnrollment.saving = true; fieldset.disabled = true;
    $('#admin-enroll-user').disabled = true; $('#btn-admin-enroll-close').disabled = true;
    try {
      await API.saveAdminEnrollment(periodId, userId, { workTypes });
      resetAdminEnrollment(); toast(state.draftSchedule?.run ? '代报名已提交，请重新生成草稿' : '代报名已提交');
      if (state.period?.id === periodId && isAdminUser()) await renderAdmin();
    } catch (err) { $('#admin-enroll-error').textContent = employeeError(err); }
    finally { proxyEnrollment.saving = false; fieldset.disabled = false; const userSelect = $('#admin-enroll-user'); if (userSelect) userSelect.disabled = false; $('#btn-admin-enroll-close').disabled = false; }
  });
}
