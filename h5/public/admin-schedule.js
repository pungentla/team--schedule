'use strict';
const adminAdjust = { mode: null, data: null, target: null, candidates: [], request: 0 };
function adjustmentError(err) {
  const problems = err.details?.problems || [];
  return `${employeeError(err)}${problems.length ? `：${problems.map((p) => p.message || p.label || p.code).join('；')}` : ''}`;
}
async function openAdminAdjust(mode) {
  await loadAdminSchedules();
  renderGenResult();
  const data = mode === 'draft' ? state.draftSchedule : state.publishedSchedule;
  if (!data?.run) return toast(mode === 'draft' ? '请先生成草稿' : '该周期尚未发布', true);
  if (data.period.status === 'archived') return toast('已归档周期不能调配', true);
  adminAdjust.mode = mode; adminAdjust.data = data;
  $('#admin-adjust-title').textContent = mode === 'draft' ? '手工调配草稿' : '直接调整已发布排班';
  const box = $('#admin-adjust-content');
  if (mode === 'draft') {
    const days = data.matrix.filter((d) => d.shifts.some((s) => s.workTypes.length));
    box.innerHTML = `<p class="notice">草稿 #${data.run.id} · 修改后需发布生效。 ${helpButton('draft')}</p><label class="field">日期<select id="adjust-date">${days.map((d) => `<option value="${d.workDate}">${friendlyDate(d.workDate)}</option>`).join('')}</select></label><label class="field">班次与工作<select id="adjust-cell"></select></label><div id="adjust-people"></div><div id="adjust-editor"></div><p id="adjust-error" class="form-error" role="alert"></p>`;
    const conflictDate = data.gaps?.fixedConflicts?.[0]?.workDate;
    if (conflictDate) $('#adjust-date').value = conflictDate;
    renderAdjustCells();
  } else {
    box.innerHTML = `<p class="notice">提交后立即生效，无需员工确认。</p><label class="field">需要调整的排班<select id="adjust-source">${data.assignments.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} · ${escapeHtml(assignmentLabel(a))}</option>`).join('')}</select></label><label class="field">调整方式<select id="adjust-type"><option value="transfer">转交另一位员工</option><option value="exchange">与另一位员工交换班次</option></select></label><div id="adjust-editor"></div><p id="adjust-error" class="form-error" role="alert"></p>`;
    if (data.assignments.length) await renderPublishedEditor();
    else $('#adjust-editor').textContent = '当前没有可调整的排班。';
  }
  $('#admin-adjust-dialog').showModal();
}
function selectedAdjustCell() {
  const [shiftId, workTypeId] = ($('#adjust-cell')?.value || '').split('|').map(Number);
  return adminAdjust.data.matrix.find((d) => d.workDate === $('#adjust-date').value)?.shifts.find((s) => s.shiftId === shiftId)?.workTypes.find((w) => w.workTypeId === workTypeId);
}
function renderAdjustCells() {
  const day = adminAdjust.data.matrix.find((d) => d.workDate === $('#adjust-date').value);
  $('#adjust-cell').innerHTML = (day?.shifts || []).flatMap((s) => s.workTypes.map((w) => `<option value="${s.shiftId}|${w.workTypeId}">${escapeHtml(s.shiftName)} · ${escapeHtml(w.workTypeName)}（${w.filled}/${w.needCount}）</option>`)).join('');
  renderAdjustPeople();
}
function renderAdjustPeople() {
  const cell = selectedAdjustCell();
  $('#adjust-editor').innerHTML = '';
  $('#adjust-error').textContent = '';
  if (!cell) { $('#adjust-people').textContent = '当天无需求。'; return; }
  $('#adjust-people').innerHTML = `<h3>当前人员（${cell.filled}/${cell.needCount}）</h3>${cell.assigned.map((a) => `<div class="adjust-person">${escapeHtml(a.name)} · ${dutyRoleLabels[a.dutyRole]}${a.isFixed ? ' · 固定人员' : ''}<div class="form-actions"><button class="btn-ghost" data-replace="${a.id}">替换人员</button><button class="btn-ghost" data-remove="${a.id}">移除此班安排</button></div></div>`).join('') || '<p class="form-help">暂无人员</p>'}
    ${cell.gap > 0 ? `<label class="field">补充岗位角色<select id="adjust-role">${(cell.requiresRoles ? ['primary', 'deputy'] : ['member']).map((role) => `<option value="${role}">${dutyRoleLabels[role]}</option>`).join('')}</select></label><button class="btn-ghost" id="btn-adjust-add">＋ 补充人员</button>` : ''}`;
}
async function renderDraftEditor(assignmentId) {
  const cell = selectedAdjustCell();
  const target = assignmentId ? { assignmentId } : { workDate: $('#adjust-date').value, shiftId: cell.shiftId, workTypeId: cell.workTypeId, dutyRole: $('#adjust-role').value };
  adminAdjust.target = target;
  const token = ++adminAdjust.request;
  $('#adjust-editor').textContent = '正在检查可用人员…';
  try {
    const result = await API.draftCandidates(adminAdjust.data.run.id, target);
    if (token !== adminAdjust.request) return;
    adminAdjust.revision = result.revision;
    const old = cell.assigned.find((a) => a.id === assignmentId);
    $('#adjust-editor').innerHTML = `<form id="draft-adjust-form"><h3>${old ? `替换 ${escapeHtml(old.name)}` : '补充人员'}</h3><label class="field">新人员<select name="userId" required><option value="">请选择人员</option>${result.candidates.map((u) => `<option value="${u.userId}" ${u.canAssign ? '' : 'disabled'}>${escapeHtml(u.name)}（${escapeHtml(u.employeeNo)}）${u.canAssign ? '' : ` · ${escapeHtml(u.problems.map((p) => p.message || p.label || p.code).join('、'))}`}</option>`).join('')}</select></label><button type="submit" class="btn-success">确认修改草稿</button></form>`;
  } catch (err) { $('#adjust-editor').textContent = ''; $('#adjust-error').textContent = adjustmentError(err); }
}
async function renderPublishedEditor() {
  const id = Number($('#adjust-source').value);
  const token = ++adminAdjust.request;
  $('#adjust-editor').textContent = '正在检查接班人员…';
  $('#adjust-error').textContent = '';
  try {
    const result = await API.swapCandidates(id);
    if (token !== adminAdjust.request) return;
    adminAdjust.candidates = result.candidates;
    const exchange = $('#adjust-type').value === 'exchange';
    $('#adjust-editor').innerHTML = `<form id="published-adjust-form"><label class="field">${exchange ? '交换对象' : '接班人员'}<select id="adjust-recipient" name="toUserId" required><option value="">请选择员工</option>${result.candidates.map((u) => `<option value="${u.userId}" ${exchange ? (u.theirAssignments.length ? '' : 'disabled') : (u.canTake ? '' : 'disabled')}>${escapeHtml(u.name)}（${escapeHtml(u.employeeNo)}）${!exchange && !u.canTake ? ` · ${escapeHtml(u.problems.map((p) => p.label || p.message || p.code).join('、'))}` : ''}</option>`).join('')}</select></label><div id="adjust-exchange"></div><label class="field">调配说明（可选）<textarea name="message" maxlength="1000" rows="2"></textarea></label><p id="adjust-confirmation" class="form-help">请选择人员，检查本次调整。</p><button type="submit" class="btn-success">确认调整，立即生效</button></form>`;
  } catch (err) { $('#adjust-editor').textContent = ''; $('#adjust-error').textContent = adjustmentError(err); }
}
function updateAdjustmentConfirmation() {
  const source = adminAdjust.data.assignments.find((a) => a.id === Number($('#adjust-source').value));
  const recipient = adminAdjust.candidates.find((u) => u.userId === Number($('#adjust-recipient').value));
  const target = recipient?.theirAssignments.find((a) => a.id === Number($('#adjust-target')?.value));
  $('#adjust-confirmation').textContent = recipient ? `${source.name}的 ${assignmentLabel(source)} 转交${recipient.name}${target ? `；${recipient.name}的 ${assignmentLabel(target)} 转交${source.name}` : ''}。无需员工确认。` : '请选择人员，检查本次调整。';
}
function bindAdminScheduleEvents() {
  $('#btn-adjust-close').addEventListener('click', () => { adminAdjust.request++; $('#admin-adjust-dialog').close(); });
  $('#btn-adjust-draft').addEventListener('click', () => openAdminAdjust('draft'));
  $('#btn-adjust-published').addEventListener('click', () => openAdminAdjust('published'));
  const box = $('#admin-adjust-content');
  box.addEventListener('change', (event) => {
    const id = event.target.id;
    if (id === 'adjust-date') renderAdjustCells();
    if (id === 'adjust-cell') renderAdjustPeople();
    if (['adjust-source', 'adjust-type'].includes(id)) renderPublishedEditor();
    if (id === 'adjust-recipient') {
      const recipient = adminAdjust.candidates.find((u) => u.userId === Number(event.target.value));
      $('#adjust-exchange').innerHTML = $('#adjust-type').value === 'exchange' && recipient ? `<label class="field">对方交出的班次<select id="adjust-target" name="toAssignmentId" required>${recipient.theirAssignments.map((a) => `<option value="${a.id}">${escapeHtml(assignmentLabel(a))}</option>`).join('')}</select></label>` : '';
      updateAdjustmentConfirmation();
    }
    if (id === 'adjust-target') updateAdjustmentConfirmation();
  });
  box.addEventListener('click', async (event) => {
    const replace = event.target.closest('[data-replace]');
    const remove = event.target.closest('[data-remove]');
    if (replace) return renderDraftEditor(Number(replace.dataset.replace));
    if (event.target.id === 'btn-adjust-add') return renderDraftEditor();
    if (remove) {
      remove.disabled = true;
      try { await saveDraftAdjustment({ action: 'remove', assignmentId: Number(remove.dataset.remove), revision: adminAdjust.data.run.revision }); }
      catch (err) { $('#adjust-error').textContent = adjustmentError(err); }
      finally { remove.disabled = false; }
    }
  });
  box.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    $('#adjust-error').textContent = '';
    try {
      if (form.id === 'draft-adjust-form') await saveDraftAdjustment({ ...adminAdjust.target, action: adminAdjust.target.assignmentId ? 'replace' : 'add', userId: Number(form.elements.userId.value), revision: adminAdjust.revision });
      else {
        await API.adminReassign({ type: $('#adjust-type').value, fromAssignmentId: Number($('#adjust-source').value), toUserId: Number(form.elements.toUserId.value), toAssignmentId: Number(form.elements.toAssignmentId?.value) || undefined, message: form.elements.message.value });
        $('#admin-adjust-dialog').close(); toast('调配已生效，无需员工操作');
        await renderSchedule(); await renderAdmin();
      }
    } catch (err) { $('#adjust-error').textContent = adjustmentError(err); }
    finally { button.disabled = false; }
  });
}
async function saveDraftAdjustment(change) {
  const date = $('#adjust-date').value;
  const cell = $('#adjust-cell').value;
  adminAdjust.request++;
  adminAdjust.data = await API.adjustDraft(adminAdjust.data.run.id, change);
  state.draftSchedule = adminAdjust.data;
  renderGenResult(); renderMetrics(); await renderAudit();
  $('#adjust-date').value = date;
  renderAdjustCells(); $('#adjust-cell').value = cell; renderAdjustPeople();
  toast('草稿已更新，发布后生效');
}
