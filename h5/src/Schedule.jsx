import React, { lazy, Suspense, useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import ConfigProvider from 'antd/es/config-provider';
import DatePicker from 'antd/es/date-picker';
import Form from 'antd/es/form';
import Modal from 'antd/es/modal';
import Segmented from 'antd/es/segmented';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Spin from 'antd/es/spin';
import Tag from 'antd/es/tag';
import { ScheduleOverview } from './ScheduleOverview';
import { MonthCalendar } from './MonthCalendar';
import { API, Blank, DutyTag, Field, Heading, Load, dateText, dayjs, group, isAdmin, iso, monthOf, option, periodOptions, personLabel, roleLabels, shiftText, today, usePageLoad, weekdays } from './shared';

const Table = lazy(() => import('antd/es/table'));
const rangePickerTheme = { components: { DatePicker: { cellWidth: 34, cellHeight: 28 } } };

const scopeOptions = [
  option('mine', '我的排班'),
  option('team', '团队排班'),
  option('work', '工作类型'),
];
const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];

function readWeekdaySelection(saved) {
  if (Array.isArray(saved?.weekdays)) return weekdayOrder.filter(day => saved.weekdays.includes(day));
  if (saved?.weekday === 'all') return weekdayOrder;
  return weekdayOrder.includes(saved?.weekday) ? [saved.weekday] : [0];
}

const pastRanges = [
  { value: 'past7', label: '过去7天', amount: 7, unit: 'day' },
  { value: 'pastMonth', label: '过去1个月', amount: 1, unit: 'month' },
  { value: 'past3months', label: '过去3个月', amount: 3, unit: 'month' },
  { value: 'pastYear', label: '过去1年', amount: 1, unit: 'year' },
];

const recentRangeOptions = [
  option('7', '未来7天（含今天）'),
  option('30', '未来30天（含今天）'),
  ...pastRanges.map(({ value, label }) => option(value, label)),
  option('custom', '自定义日期'),
];

function validCustomDates(start, end) {
  return !!start && !!end && start.isValid() && end.isValid()
    && !end.isBefore(start, 'day') && end.diff(start, 'day') <= 365;
}

const filterKey = userId => `teamshift_schedule_filters:${userId}`;

export function readScheduleFilters(userId) {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(filterKey(userId)));
  } catch {
    // 浏览器存储不可用时使用默认筛选。
  }
  const scope = scopeOptions.some(o => o.value === saved?.scope) ? saved.scope : 'mine';
  const byScope = Object.fromEntries(scopeOptions.map(({ value }) => [value, readScopeFilters(saved?.byScope ? saved.byScope[value] : saved)]));
  return { scope, byScope };
}

function readScopeFilters(saved) {
  const dates = saved?.dates;
  const validDates = Array.isArray(dates) && dates.length === 2
    && dates.every(date => typeof date === 'string' && iso(dayjs(date)) === date)
    && validCustomDates(dayjs(dates[0]), dayjs(dates[1]));
  return {
    view: ['recent', 'calendar', 'matrix', 'daily'].includes(saved?.view) ? saved.view : 'recent',
    weekdays: readWeekdaySelection(saved),
    range: recentRangeOptions.some(o => o.value === saved?.range) ? saved.range : '7',
    dates: validDates ? dates : null,
    work: Number.isInteger(saved?.work) ? saved.work : undefined,
    person: Number.isInteger(saved?.person) ? saved.person : 'all',
    periodId: Number.isInteger(saved?.periodId) ? saved.periodId : undefined,
  };
}

export function saveScheduleFilters(userId, filters) {
  try {
    localStorage.setItem(filterKey(userId), JSON.stringify(filters));
  } catch {
    // 当前页面仍可使用内存中的筛选。
  }
}

function recentParams(range, dates) {
  if (range === 'custom' && dates) return { startDate: dates[0], endDate: dates[1] };
  const past = pastRanges.find(item => item.value === range);
  if (past) {
    const currentDate = dayjs(today());
    return {
      startDate: iso(currentDate.subtract(past.amount, past.unit)),
      endDate: iso(currentDate.subtract(1, 'day')),
    };
  }
  return { days: range === 'custom' ? 7 : range };
}

export function Schedule({ user, periods, period, scope, changeScope, filters, updateFilters }) {
  const { work, range, dates, weekdays: selectedWeekdays } = filters;
  const allWeekdaysSelected = selectedWeekdays.length === weekdayOrder.length;
  const [custom, setCustom] = useState(() => dates?.map(date => dayjs(date)) ?? [dayjs(today()), dayjs(today()).add(6, 'day')]);
  const viewOptions = [option('recent', '近期安排')];
  if (scope !== 'work') viewOptions.push(option('calendar', '月历'));
  if (scope === 'team') {
    viewOptions.push(option('matrix', '排班矩阵'));
    if (isAdmin(user)) viewOptions.push(option('daily', '按人员日表'));
  }
  const view = viewOptions.some(o => o.value === filters.view) ? filters.view : 'recent';
  const recent = usePageLoad(view === 'recent' ? JSON.stringify([scope, range, dates]) : null,
    () => API.recentSchedule(recentParams(range, dates), scope));
  const works = usePageLoad(scope === 'work' ? 'works' : null, API.workTypes);
  const waitingForWorks = scope === 'work' && (works.error || (works.loading && works.data === undefined));
  const schedule = usePageLoad(view !== 'recent' ? period?.id : null, () => API.schedule(period.id, 'published'));
  const assignments = recent.data?.assignments || [];
  const usedWorks = new Set(assignments.map(a => a.workTypeId));
  const choices = (works.data || []).filter(w => w.active || usedWorks.has(w.id));
  const workId = choices.some(w => w.id === work) ? work : choices[0]?.id;
  const list = assignments.filter(a => (scope !== 'work' || a.workTypeId === workId) && selectedWeekdays.includes(dayjs(a.workDate).day()));
  const canFilterPerson = scope === 'team' && ['calendar', 'daily'].includes(view) && isAdmin(user);
  const people = canFilterPerson ? peopleOf(schedule.data) : [];
  const person = people.some(p => p.id === filters.person) ? filters.person : 'all';
  return <>
    <Card><Heading help="recent">工作台</Heading>
      <Segmented block value={scope} onChange={changeScope} options={scopeOptions} />
      <Form layout="vertical" className="filters">
        {scope !== 'work' && <Field label="查看"><Select aria-label="查看" value={view} onChange={value => updateFilters({ view: value })} options={viewOptions} /></Field>}
        {scope === 'work' && <Field label="工作类型"><Select aria-label="工作类型" loading={works.loading} value={workId} onChange={value => updateFilters({ work: value })} options={choices.map(w => option(w.id, w.name))} /></Field>}
        {view === 'recent' ? <>
          <Field label="时间范围"><Select aria-label="时间范围" value={range} onChange={value => updateFilters({ range: value })} options={recentRangeOptions} /></Field>
          {range === 'custom' && <Form.Item label="日期范围" htmlFor="schedule-range-start">
            <div className="schedule-range-row">
              <ConfigProvider theme={rangePickerTheme}>
                <DatePicker.RangePicker
                  id={{ start: 'schedule-range-start', end: 'schedule-range-end' }}
                  placeholder={['开始日期', '结束日期']}
                  value={custom}
                  onChange={value => setCustom(value)}
                  disabledDate={(date, { from }) => !!from && Math.abs(date.diff(from, 'day')) > 365}
                  classNames={{ popup: { root: 'schedule-range-popup' } }}
                />
              </ConfigProvider>
              <Button type="primary" disabled={!custom || !validCustomDates(...custom)}
                onClick={() => updateFilters({ dates: custom.map(iso) })}>查看安排</Button>
            </div>
          </Form.Item>}
        </> : <Field label="排班周期"><Select aria-label="排班周期" value={period?.id} options={periodOptions(periods)} onChange={value => updateFilters({ periodId: value })} placeholder="暂无排班周期" /></Field>}
        <Field label="仅查看"><Checkbox.Group className="schedule-weekdays" role="group" aria-label="仅查看星期"
          value={selectedWeekdays} onChange={value => updateFilters({ weekdays: value })}>
          <Checkbox skipGroup checked={allWeekdaysSelected} indeterminate={selectedWeekdays.length > 0 && !allWeekdaysSelected}
            onChange={event => updateFilters({ weekdays: event.target.checked ? weekdayOrder : [] })}>全选</Checkbox>
          {weekdayOrder.map(day => <Checkbox key={day} value={day}>{weekdays[day]}</Checkbox>)}
        </Checkbox.Group></Field>
        {canFilterPerson && <Field label="人员"><Select aria-label="人员" showSearch optionFilterProp="label" value={person} onChange={value => updateFilters({ person: value })} options={[option('all', '所有人员'), ...people.map(p => option(p.id, personLabel(p)))]} /></Field>}
      </Form>
      {view === 'recent' && recent.data && !waitingForWorks && <div className="muted">{recent.data.startDate} 至 {recent.data.endDate} · {list.length} 项</div>}
      {view !== 'recent' && period && <div className="muted">{period.startDate} 至 {period.endDate} · {schedule.data?.run ? `生效版本 #${schedule.data.run.id}` : '尚未发布'}</div>}
    </Card>
    {view === 'recent' ? waitingForWorks ? <Load query={works} /> : <Load query={recent}>{data => <>
      <ScheduleOverview assignments={list} startDate={data.startDate} endDate={data.endDate} scope={scope} weekdays={selectedWeekdays} />
      <RecentList list={list} mine={scope === 'mine'} user={user} empty={scope === 'work' ? '该工作暂无排班' : scope === 'mine' ? '这段时间暂无我的安排' : '这段时间暂无团队排班'} />
    </>}</Load>
      : <Load query={schedule} empty="还没有排班周期">{data => <PeriodView key={data.period.id} data={data} user={user} scope={scope} view={view} person={person} selectedWeekdays={selectedWeekdays} />}</Load>}
  </>;
}

function peopleOf(data) {
  const people = new Map((data?.employees || []).map(p => [p.id, p]));
  for (const a of data?.assignments || []) if (!people.has(a.userId)) people.set(a.userId, { ...a, id: a.userId });
  return [...people.values()];
}

export function Assignment({ a, person = false, recent = false }) {
  return <div className="assignment"><div className="inline"><strong><i className="dot" style={{ background: a.workTypeColor }} />{a.workTypeName}</strong><DutyTag role={a.dutyRole} /></div>
    <div className="muted">{person && `${a.name} · `}{shiftText(a)}{a.periodName && ` · ${a.periodName}`}</div>
    {recent && <Space size={[6, 4]} wrap><span className="muted">同伴</span>{a.coworkers?.length ? a.coworkers.map(c => <Tag key={c.userId}>{c.name}{c.dutyRole !== 'member' && ` · ${roleLabels[c.dutyRole]}`}</Tag>) : <span className="muted">暂无其他已排人员</span>}</Space>}
  </div>;
}
function RecentList({ list, mine, user, empty }) {
  return list.length ? group(list, a => a.workDate).map(([date, items]) => <Card key={date} title={`${dateText(date)}${date === today() ? ' · 今天' : ''}`} extra={!mine && <Tag color="blue">{new Set(items.map(a => a.userId)).size} 人</Tag>}>
    {mine ? items.map(a => <Assignment key={a.id} a={a} recent />) : group(items, a => a.userId).map(([id, jobs]) => <div className="person-row" key={id}>
      <strong>{jobs[0].name}{id === user.id && <Tag color="red">我</Tag>}</strong>
      <div>{jobs.map(a => <Assignment key={a.id} a={a} />)}</div>
    </div>)}
  </Card>) : <Blank>{empty}</Blank>;
}

function PeriodView({ data, user, scope, view, person, selectedWeekdays }) {
  const { period } = data;
  const initial = today() >= period.startDate && today() <= period.endDate ? today() : period.startDate;
  const [pickedDay, setDay] = useState(initial);
  const [dialogDay, setDialogDay] = useState();
  const [month, setMonth] = useState(monthOf(initial));
  const onWeekday = date => selectedWeekdays.includes(dayjs(date).day());
  const list = data.assignments.filter(a => onWeekday(a.workDate)
    && (scope === 'mine' ? a.userId === user.id : person === 'all' || a.userId === person));
  const matrix = data.matrix.filter(d => onWeekday(d.workDate));
  const gaps = selectedWeekdays.length === weekdays.length ? data.gaps : matrix.flatMap(d => d.shifts).flatMap(s => s.workTypes)
    .reduce((total, work) => ({
      totalGap: total.totalGap + work.gap,
      totalFilled: total.totalFilled + work.filled,
      totalNeeded: total.totalNeeded + work.needCount,
    }), { totalGap: 0, totalFilled: 0, totalNeeded: 0 });
  const blocked = d => iso(d) < period.startDate || iso(d) > period.endDate || !selectedWeekdays.includes(d.day());
  let day = pickedDay;
  if (!onWeekday(day)) {
    const selected = dayjs(day);
    const offsets = [1, 2, 3, 4, 5, 6];
    const nearby = [...offsets, ...offsets.map(n => -n)].map(n => selected.add(n, 'day'));
    const fallback = nearby.find(date => !blocked(date));
    day = fallback ? iso(fallback) : null;
  }
  function pick(date) { setDay(date); setMonth(monthOf(date)); if (view === 'calendar') setDialogDay(date); }
  return <>
    {data.run && <ScheduleOverview assignments={list} startDate={period.startDate} endDate={period.endDate} scope={scope} weekdays={selectedWeekdays} />}
    {scope === 'team' && data.run && gaps?.totalGap > 0 && <Alert showIcon type="warning" message={`缺口 ${gaps.totalGap} 人次 · 已排 ${gaps.totalFilled}/${gaps.totalNeeded}`} />}
    {!data.run && <Alert showIcon message="本周期尚未发布排班" />}
    {view === 'matrix' && <Matrix data={{ matrix }} user={user} />}
    {view === 'daily' && (day ? <Card title={`${dateText(day)} · 按人员日表`}>
        <DatePicker aria-label="查看日期" allowClear={false} value={dayjs(day)} disabledDate={blocked} onChange={d => d && pick(iso(d))} />
        <Suspense fallback={<Spin />}><Table size="small" rowKey="id" pagination={false} dataSource={peopleOf(data).filter(p => person === 'all' || person === p.id)} columns={[
          { title: '人员', dataIndex: 'name', width: '30%', render: (name, p) => <>{name}<div className="muted">{p.employeeNo}</div></> },
          { title: '当天安排', render: (_, p) => { const items = list.filter(a => a.userId === p.id && a.workDate === day); return items.length ? items.map(a => <Assignment key={a.id} a={a} />) : '当日无排班'; } },
        ]} /></Suspense>
    </Card> : <Blank>本周期没有符合筛选的日期</Blank>)}
    {view === 'calendar' && <>
      <Calendar period={period} month={month} move={setMonth} assignments={list} selected={day} pick={pick} blocked={blocked} />
      <Modal title={dialogDay ? dateText(dialogDay) + ' · 当天安排' : ''} open={!!dialogDay && onWeekday(dialogDay)} onCancel={() => setDialogDay(null)} footer={<Button onClick={() => setDialogDay(null)}>关闭</Button>}>
        {dialogDay && (list.some(a => a.workDate === dialogDay) ? list.filter(a => a.workDate === dialogDay).map(a => <Assignment key={a.id} a={a} person={scope === 'team'} />) : <Blank>当天没有排班</Blank>)}
      </Modal>
    </>}
  </>;
}

function Calendar({ period, month, move, assignments, selected, pick, blocked }) {
  const counts = new Map(group(assignments, a => a.workDate));
  return <Card className="calendar"><MonthCalendar startDate={period.startDate} endDate={period.endDate}
    month={month} move={move} selected={selected} pick={pick} blocked={blocked}
    dayInfo={date => {
      const count = counts.get(date)?.length || 0;
      return { label: `${count} 项安排`, badge: count > 0 && <small>{count} 项</small> };
    }} /></Card>;
}

export function ScheduleDetails({ data, user, view, setView, published = false, onAdjustWork }) {
  const { startDate, endDate } = data.period;
  const [month, setMonth] = useState(monthOf(startDate));
  const [date, setDate] = useState(null);
  const days = new Map(data.matrix.map(day => [day.workDate, day]));
  const selectedDay = days.get(date);
  function dayInfo(day) {
    const works = days.get(day)?.shifts.flatMap(shift => shift.workTypes) || [];
    const filled = works.reduce((count, work) => count + work.filled, 0);
    const needed = works.reduce((count, work) => count + work.needCount, 0);
    return {
      label: `已排 ${filled} / ${needed} 人次`,
      badge: (needed > 0 || filled > 0) && <small className={`calendar-count${works.some(work => work.gap > 0) ? ' draft-calendar-gap' : ''}`}>{filled}/{needed}</small>,
    };
  }
  return <div className="stack">
    <Segmented block aria-label={published ? '生效明细视图' : '草稿明细视图'} value={view} onChange={setView}
      options={[option('calendar', '日历'), option('list', '列表')]} />
    {published && (view === 'calendar' || onAdjustWork) && <div className="muted">
      {view === 'calendar' && '点击日期查看当天安排。'}
      {onAdjustWork && '点击工作旁的「调班」可调整安排。'}
    </div>}
    {view === 'list' ? <Matrix data={data} user={user} onAdjustWork={onAdjustWork} /> : <>
      <MonthCalendar month={month} startDate={startDate} endDate={endDate} move={setMonth} selected={date} pick={setDate}
        blocked={day => iso(day) < startDate || iso(day) > endDate} dayInfo={dayInfo} />
      <Modal open={!!date} title={date && `${dateText(date)} · ${published ? '生效安排' : '草稿安排'}`} onCancel={() => setDate(null)}
        footer={<Space>
          {onAdjustWork && <Button onClick={() => onAdjustWork({ workDate: date })}>新增工作</Button>}
          <Button onClick={() => setDate(null)}>关闭</Button>
        </Space>}>
        <Matrix data={{ matrix: selectedDay ? [selectedDay] : [] }} user={user} showDate={false} onAdjustWork={onAdjustWork} />
      </Modal>
    </>}
  </div>;
}

export function Matrix({ data, user, showDate = true, onAdjustWork }) {
  return data?.matrix?.length ? data.matrix.map(d => <Card size="small" key={d.workDate} title={showDate ? dateText(d.workDate) : undefined}>
    {d.shifts.map(s => <div key={s.shiftId}><h3>{s.shiftName}</h3>
      {s.workTypes.map(w => <div className={onAdjustWork ? 'matrix-row matrix-row-adjustable' : 'matrix-row'} key={w.workTypeId}><strong><i className="dot" style={{ background: w.workTypeColor }} />{w.workTypeName}</strong>
        <Space wrap size={[4, 4]}>{w.assigned.map(p => <Tag key={p.userId} color={p.source === 'swap' ? 'purple' : p.userId === user?.id ? 'blue' : 'default'}>{p.name}{p.isFixed ? '（固定）' : p.source === 'swap' ? '（换班）' : p.source === 'manual' ? '（调配）' : ''}{p.dutyRole !== 'member' && ` · ${roleLabels[p.dutyRole]}`}</Tag>)}
          {!w.assigned.length && <Tag>无人</Tag>}<Tag color={w.gap ? 'red' : 'green'}>{w.gap ? `缺 ${w.gap}` : w.fillAllEnrolled ? `已排 ${w.filled} · 最少 ${w.needCount}` : `${w.filled}/${w.needCount}`}</Tag>
          {w.roleGaps?.map(r => <Tag color="red" key={r}>缺{roleLabels[r]}</Tag>)}
        </Space>
        {onAdjustWork && <Button type="link" size="small" aria-label={`${dateText(d.workDate)} ${s.shiftName} ${w.workTypeName} 调班`}
          onClick={() => onAdjustWork({ workDate: d.workDate, shiftId: s.shiftId, workTypeId: w.workTypeId })}>调班</Button>}
      </div>)}
    </div>)}
  </Card>) : <Blank>暂无排班明细</Blank>;
}
