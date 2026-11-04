'use strict';

const scheduleView = { mode: 'recent', person: null, day: null, month: null };
function resetScheduleViews() { Object.assign(scheduleView, { mode: 'recent', person: null, day: null, month: null }); $('#calendar-day-dialog').close(); }
function shanghaiToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }

function renderScheduleViews(data) {
  const period = data.period;
  const admin = isAdminUser();
  $('#schedule-period').innerHTML = (state.periods || [period]).map((p) => `<option value="${p.id}">${escapeHtml(p.name)}（${periodLabels[p.status] || escapeHtml(p.status)}）</option>`).join('');
  $('#schedule-period').value = period.id;
  const people = new Map((data.employees || []).map((p) => [p.id, p]));
  data.assignments.forEach((a) => { if (!people.has(a.userId)) people.set(a.userId, { id: a.userId, name: a.name, employeeNo: a.employeeNo }); });
  const select = $('#schedule-person');
  if (scheduleView.person === null) scheduleView.person = admin ? 'all' : String(state.user.id);
  select.innerHTML = `<option value="all">全部员工</option>` + (admin ? [...people.values()].map((p) => `<option value="${p.id}">${escapeHtml(p.name)}（${escapeHtml(p.employeeNo)}）</option>`).join('') : `<option value="${state.user.id}">我的排班</option>`);
  select.value = scheduleView.person;
  if (!select.value) { scheduleView.person = admin ? 'all' : String(state.user.id); select.value = scheduleView.person; }
  $('#schedule-daily-option').disabled = !admin;
  $('#schedule-daily-option').hidden = !admin;
  if (!admin && scheduleView.mode === 'daily') scheduleView.mode = 'calendar';
  $('#schedule-view').value = scheduleView.mode;
  $('#schedule-person').closest('label').classList.toggle('hidden', scheduleView.mode === 'matrix');
  $('#schedule-day-field').classList.toggle('hidden', scheduleView.mode === 'matrix');
  const today = shanghaiToday();
  if (!scheduleView.day || scheduleView.day < period.startDate || scheduleView.day > period.endDate) scheduleView.day = today >= period.startDate && today <= period.endDate ? today : period.startDate;
  const dayInput = $('#schedule-day');
  dayInput.min = period.startDate; dayInput.max = period.endDate; dayInput.value = scheduleView.day;
  if (!scheduleView.month || scheduleView.month < period.startDate.slice(0, 7) || scheduleView.month > period.endDate.slice(0, 7)) scheduleView.month = scheduleView.day.slice(0, 7);
  $('#schedule-period-label').textContent = `${period.name} · ${period.startDate} 至 ${period.endDate} · ${data.run ? `生效版本 #${data.run.id}` : '尚未发布'}`;
  const assignments = data.assignments.filter((a) => scheduleView.person === 'all' || String(a.userId) === scheduleView.person);
  if (data.run && !(data.gaps?.totalGap > 0)) $('#gap-banner').classList.toggle('hidden', scheduleView.mode === 'calendar');
  if (scheduleView.mode === 'matrix') {
    $('#matrix').innerHTML = data.run ? scheduleMatrixHtml(data) : '<p class="empty-tip">该周期尚未发布排班，请等待管理员发布。</p>';
  } else if (scheduleView.mode === 'daily') {
    const staff = [...people.values()].filter((p) => scheduleView.person === 'all' || String(p.id) === scheduleView.person);
    $('#matrix').innerHTML = `<div class="panel"><h2>${friendlyDate(scheduleView.day)} · 按人员日表</h2><div class="requirements-scroll"><table class="staff-table"><thead><tr><th>员工</th><th>当天安排</th></tr></thead><tbody>${staff.map((p) => {
      const list = assignments.filter((a) => a.userId === p.id && a.workDate === scheduleView.day);
      return `<tr><th>${escapeHtml(p.name)}<br><small>${escapeHtml(p.employeeNo)}</small></th><td>${list.map((a) => `<p>${escapeHtml(a.shiftName)} ${escapeHtml(a.startTime || '')}–${escapeHtml(a.endTime || '')} · ${escapeHtml(a.workTypeName)}${a.dutyRole !== 'member' ? ` · ${dutyRoleLabels[a.dutyRole] || ''}` : ''}</p>`).join('') || '<span class="form-help">当日无排班</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>${staff.length ? '' : '<p class="empty-tip">暂无员工。</p>'}</div>`;
  } else {
    renderScheduleCalendar(assignments, period, today);
  }
}

function renderScheduleCalendar(assignments, period, today) {
  const [year, month] = scheduleView.month.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const startOffset = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const count = Math.ceil((startOffset + days) / 7) * 7;
  const cells = Array.from({ length: count }, (_, i) => {
    const day = i - startOffset + 1;
    if (day < 1 || day > days) return '<div class="calendar-blank" aria-hidden="true"></div>';
    const date = `${scheduleView.month}-${String(day).padStart(2, '0')}`;
    const outside = date < period.startDate || date > period.endDate;
    const list = assignments.filter((a) => a.workDate === date);
    return `<button class="calendar-day ${date === today ? 'is-today' : ''} ${date === scheduleView.day ? 'is-selected' : ''}" data-calendar-date="${date}" ${outside ? 'disabled' : ''} aria-label="${date}，${list.length} 项安排" aria-pressed="${date === scheduleView.day}"><span class="calendar-number">${day}</span>${list.length ? `<span class="calendar-count">${list.length} 项</span>` : ''}${list.slice(0, 3).map((a) => `<span class="calendar-entry">${escapeHtml(a.name)} · ${escapeHtml(a.shiftName)}<br>${escapeHtml(a.workTypeName)}${a.dutyRole !== 'member' ? ` · ${dutyRoleLabels[a.dutyRole] || ''}` : ''}</span>`).join('')}${list.length > 3 ? `<span class="form-help calendar-more">还有 ${list.length - 3} 项</span>` : ''}</button>`;
  }).join('');
  $('#matrix').innerHTML = `<div class="panel calendar-panel"><div class="section-heading"><button class="btn-ghost" data-calendar-move="-1" ${scheduleView.month <= period.startDate.slice(0, 7) ? 'disabled' : ''}>上个月</button><h2>${year} 年 ${month} 月</h2><button class="btn-ghost" data-calendar-move="1" ${scheduleView.month >= period.endDate.slice(0, 7) ? 'disabled' : ''}>下个月</button></div><div class="calendar-grid">${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<div class="calendar-weekday">周${w}</div>`).join('')}${cells}</div><div class="calendar-help">${helpButton('calendar')}</div></div>`;
}

function showCalendarDay() {
  const data = state.schedule;
  if (!data) return;
  const list = data.assignments.filter((a) => a.workDate === scheduleView.day && (scheduleView.person === 'all' || String(a.userId) === scheduleView.person));
  $('#calendar-day-title').textContent = `${scheduleView.day.slice(0, 4)}年 ${friendlyDate(scheduleView.day)}`;
  $('#calendar-day-content').innerHTML = `<p class="form-help">${scheduleView.person === 'all' ? '全部员工' : $('#schedule-person option:checked').textContent} · ${list.length} 项已发布安排</p>
    ${list.length ? `<div class="day-assignments">${list.map((a) => `<article class="day-assignment"><div class="section-heading"><b>${escapeHtml(a.name)}</b>${a.dutyRole && a.dutyRole !== 'member' ? `<span class="count-tag">${dutyRoleLabels[a.dutyRole]}</span>` : ''}</div><h3>${escapeHtml(a.workTypeName)}</h3><p>${escapeHtml(a.shiftName)} ${escapeHtml(a.startTime || '')}–${escapeHtml(a.endTime || '')}</p></article>`).join('')}</div>` : '<p class="empty-tip">当天没有排班安排。</p>'}`;
  const dialog = $('#calendar-day-dialog');
  if (!dialog.open) dialog.showModal();
}

function bindScheduleViewEvents() {
  $('#schedule-period').addEventListener('change', async (event) => {
    const period = (state.periods || []).find((p) => String(p.id) === event.target.value);
    if (!period) return;
    state.period = period; state.lastRunId = null;
    await renderSchedule();
  });
  $('#schedule-view').addEventListener('change', async (event) => { scheduleView.mode = event.target.value; await renderSchedule(); });
  $('#schedule-person').addEventListener('change', (event) => { scheduleView.person = event.target.value; if (state.schedule) renderScheduleViews(state.schedule); });
  $('#schedule-day').addEventListener('change', (event) => {
    if (!event.target.validity.valid || !event.target.value) return;
    scheduleView.day = event.target.value;
    scheduleView.month = scheduleView.day.slice(0, 7);
    if (state.schedule) renderScheduleViews(state.schedule);
    if (scheduleView.mode === 'calendar') showCalendarDay();
  });
  $('#matrix').addEventListener('click', (event) => {
    const day = event.target.closest('[data-calendar-date]');
    const move = event.target.closest('[data-calendar-move]');
    if (day && !day.disabled) scheduleView.day = day.dataset.calendarDate;
    else if (move && !move.disabled) {
      const [y, m] = scheduleView.month.split('-').map(Number);
      const next = new Date(Date.UTC(y, m - 1 + Number(move.dataset.calendarMove), 1)).toISOString().slice(0, 7);
      scheduleView.month = next;
      scheduleView.day = next === state.period.startDate.slice(0, 7) ? state.period.startDate : `${next}-01`;
    } else return;
    renderScheduleViews(state.schedule);
    if (day) showCalendarDay();
  });
  $('#btn-calendar-close').addEventListener('click', () => $('#calendar-day-dialog').close());
  $('#calendar-day-dialog').addEventListener('click', (event) => {
    const dialog = event.currentTarget;
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
}
