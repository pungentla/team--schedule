'use strict';
const recentView = { range: '7', startDate: null, endDate: null, request: 0 };
function resetRecentSchedule() {
  recentView.request++; recentView.range = '7'; recentView.startDate = null; recentView.endDate = null;
  $('#recent-range').value = '7'; $('#recent-error').textContent = '';
}
async function renderRecentSchedule() {
  const token = ++recentView.request;
  const box = $('#matrix');
  state.schedule = null;
  $('#recent-range').value = recentView.range;
  $$('.recent-custom').forEach((el) => el.classList.toggle('hidden', recentView.range !== 'custom'));
  $$('#recent-filter-form input').forEach((el) => { el.disabled = recentView.range !== 'custom'; });
  $('#recent-error').textContent = '';
  box.innerHTML = '<p class="empty-tip">加载近期安排…</p>';
  const params = recentView.range === 'custom' ? { startDate: recentView.startDate, endDate: recentView.endDate } : { days: recentView.range };
  try {
    const data = await API.recentSchedule(params);
    if (!state.user || scheduleView.mode !== 'recent' || token !== recentView.request) return;
    recentView.startDate = data.startDate; recentView.endDate = data.endDate;
    $('#recent-start').value = data.startDate; $('#recent-end').value = data.endDate;
    $('#schedule-period-label').textContent = `${data.startDate} 至 ${data.endDate} · ${data.assignments.length} 项`;
    const groups = new Map();
    for (const a of data.assignments) { if (!groups.has(a.workDate)) groups.set(a.workDate, []); groups.get(a.workDate).push(a); }
    box.innerHTML = groups.size ? [...groups].map(([date, assignments]) => `<section class="recent-day"><h3>${escapeHtml(date)} · ${friendlyDate(date).split(' ').pop()}${date === shanghaiToday() ? ' · 今天' : ''}</h3>${assignments.map((a) => `<article class="panel recent-assignment"><div class="section-heading"><h2><span class="dot" style="background:${escapeHtml(a.workTypeColor)}"></span>${escapeHtml(a.workTypeName)}</h2>${a.dutyRole !== 'member' ? `<span class="count-tag">我 · ${dutyRoleLabels[a.dutyRole]}</span>` : ''}</div><p class="recent-shift">${escapeHtml(a.shiftName)} · ${escapeHtml(a.startTime)}–${escapeHtml(a.endTime)}</p><div class="recent-coworkers"><span class="form-help">同伴</span>${a.coworkers.length ? a.coworkers.map((c) => `<span class="person">${escapeHtml(c.name)}${c.dutyRole !== 'member' ? ` · ${dutyRoleLabels[c.dutyRole]}` : ''}</span>`).join('') : '<span class="form-help">暂无其他已排人员</span>'}</div><p class="recent-period">${escapeHtml(a.periodName)}</p></article>`).join('')}</section>`).join('') : '<div class="panel empty-tip">这段时间暂无我的安排</div>';
  } catch (err) {
    if (token !== recentView.request || !state.user || scheduleView.mode !== 'recent') return;
    $('#recent-error').textContent = employeeError(err); box.innerHTML = '';
  }
}
function bindRecentScheduleEvents() {
  $('#recent-range').addEventListener('change', async (event) => {
    recentView.range = event.target.value;
    $$('.recent-custom').forEach((el) => el.classList.toggle('hidden', recentView.range !== 'custom'));
  $$('#recent-filter-form input').forEach((el) => { el.disabled = recentView.range !== 'custom'; });
    if (recentView.range !== 'custom') await renderRecentSchedule();
  });
  $('#recent-filter-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    recentView.startDate = $('#recent-start').value; recentView.endDate = $('#recent-end').value;
    await renderRecentSchedule();
  });
}
