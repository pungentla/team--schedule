import React, { useState } from 'react';
import Alert from 'antd/es/alert';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import Collapse from 'antd/es/collapse';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Tag from 'antd/es/tag';
import { MonthCalendar } from './MonthCalendar';
import { ScheduleDetails } from './Schedule';
import { API, Blank, Field, Heading, Help, Load, checkRemoval, dateText, iso, monthOf, option, periodOptions, personLabel, roleLabels, roleOptions, savedEnrollment, shiftText, timeText, useAction, useLoad, usePageLoad, weekdays } from './shared';

const canEnroll = period => ['enrolling', 'scheduling', 'published'].includes(period?.status);
const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
const openDays = work => weekdayOrder.filter(day => work.weekdays.includes(day));

function enrollmentAction(enrollment) {
  return enrollment.status === 'submitted' ? '修改报名信息' : '打开报名表';
}

function EnrollmentStatus({ enrollment }) {
  const submitted = enrollment.status === 'submitted';
  return <Tag color={submitted ? 'green' : 'default'}>{submitted ? '已提交' : '尚未报名'}</Tag>;
}

export function Enrollment({ user, periods, period, selected, setSelected }) {
  const options = [...periods].sort((a, b) => Number(canEnroll(b)) - Number(canEnroll(a)));
  const [openPeriod, setOpenPeriod] = useState(null);
  const selection = selected == null
    ? options.find(p => p.id === period?.id && canEnroll(p)) || options[0]
    : options.find(p => p.id === selected);
  const enrollmentPeriodId = openPeriod?.id ?? selection?.id;
  const details = usePageLoad(enrollmentPeriodId, () => Promise.all([
    API.enrollContext(enrollmentPeriodId),
    API.myEnrollment(enrollmentPeriodId),
  ]));

  return <>
    <Card><Heading help="enroll">我的报名</Heading>
      {options.length > 0 && <>
        <Form layout="vertical">
          <Field label="排班周期">
            <Select aria-label="排班周期" value={selection?.id} onChange={setSelected} options={periodOptions(options)} placeholder="请选择周期" />
          </Field>
        </Form>
      </>}
      {selection ? <div className="stack">
        <div className="muted">{selection.startDate} 至 {selection.endDate}</div>
        {selection.status === 'published' && <Collapse key={selection.id} className="compact-calendar" items={[{
          key: 'published', label: '查看生效明细', children: <PublishedEnrollmentDetails periodId={selection.id} user={user} />,
        }]} />}
      </div>
        : <Blank>{selected == null ? '暂无报名周期' : '该排班周期已不可查看'}</Blank>}
    </Card>
    {selection && <Card title="报名信息">
      <Load query={details}>{([context, enrollment]) => (
        <EnrollmentSummary context={context} enrollment={enrollment} edit={() => setOpenPeriod({ id: selection.id, name: selection.name })} />
      )}</Load>
    </Card>}
    {openPeriod && <EnrollmentDialog period={openPeriod} details={details}
      close={() => setOpenPeriod(current => current === openPeriod ? null : current)} />}
  </>;
}

function PublishedEnrollmentDetails({ periodId, user }) {
  const [view, setView] = useState('calendar');
  const query = usePageLoad(periodId, () => API.schedule(periodId, 'published'));
  return <Load query={query}>{data => data.run
    ? <ScheduleDetails data={data} user={user} view={view} setView={setView} published />
    : <Blank>本周期暂无已发布排班</Blank>}</Load>;
}

function enrollmentAvailability(context, enrollment) {
  const all = context.shifts.map(s => s.id);
  const byDate = new Map();
  for (const { workDate, shiftId } of enrollment.availability) {
    if (!byDate.has(workDate)) byDate.set(workDate, []);
    byDate.get(workDate).push(shiftId);
  }
  const blocked = new Set(enrollment.unavailability.map(a => a.workDate));
  return Object.fromEntries(context.dates.map(date => [
    date, blocked.has(date) ? [] : enrollment.availability.length ? byDate.get(date) || [] : all,
  ]));
}

function EnrollmentSummary({ context, enrollment, edit }) {
  return <div className="stack">
    <div className="row-between">
      <EnrollmentStatus enrollment={enrollment} />
      {canEnroll(context.period) && <Button type="primary" onClick={edit}>{enrollmentAction(enrollment)}</Button>}
    </div>
    {enrollment.status === 'submitted' && <>
      <div className="enrollment-summary muted">
        {enrollment.submittedAt && <p>提交时间：{timeText(enrollment.submittedAt)}</p>}
        {enrollment.submittedByName && <p>代报名人：{enrollment.submittedByName}</p>}
      </div>
      <section>
        <h3>报名工作</h3>
        {enrollment.workTypes.length ? enrollment.workTypes.map(work => (
          <div className="choice row-between enrollment-summary" key={work.workTypeId}>
            <strong>{work.name}</strong>
            <Space wrap size={[4, 4]}>
              <Tag color="blue">{work.weekdays ? weekdayOrder.filter(day => work.weekdays.includes(day)).map(day => weekdays[day]).join('、') : '所有开放工作日'}</Tag>
              <Tag>意愿 {work.priority} 级</Tag>
              {work.dutyRole !== 'member' && roleLabels[work.dutyRole] && <Tag>{roleLabels[work.dutyRole]}</Tag>}
            </Space>
          </div>
        )) : <p className="muted">未选择报名工作</p>}
      </section>
      {enrollment.maxShifts != null && <p><strong>本周期班次上限：</strong>{enrollment.maxShifts} 班</p>}
      <AvailabilitySummary context={context} enrollment={enrollment} />
      <section>
        <h3>备注</h3>
        <p className="enrollment-note">{enrollment.note?.trim() ? enrollment.note : '无'}</p>
      </section>
    </>}
  </div>;
}

function AvailabilitySummary({ context, enrollment }) {
  if (!context.dates.length || !context.shifts.length) return <p><strong>可用时间：</strong>暂无班次</p>;
  const available = enrollmentAvailability(context, enrollment);
  const reasons = new Map(enrollment.unavailability.map(a => [a.workDate, a.reason]));
  const restricted = context.dates.flatMap(date => {
    const shifts = context.shifts.filter(s => available[date].includes(s.id));
    return shifts.length < context.shifts.length ? [{ date, shifts }] : [];
  });
  if (!restricted.length) return <p><strong>可用时间：</strong>所有班次均可</p>;
  return <Collapse size="small" items={[{
    key: 'availability',
    label: `可用时间 · ${restricted.length} 天有时间限制`,
    children: <div className="stack enrollment-summary">
      {restricted.length < context.dates.length && <p className="muted">其余日期的班次均可。</p>}
      {restricted.map(({ date, shifts }) => <div key={date}>
        <strong>{dateText(date)}</strong>
        <p>{shifts.length ? shifts.map(shiftText).join('、') : '整天不可用'}</p>
        {!shifts.length && reasons.get(date) && <p className="muted">{reasons.get(date)}</p>}
      </div>)}
    </div>,
  }]} />;
}

function EnrollmentDialog({ period, details, close }) {
  const enrollment = details.data?.[1];
  const action = enrollment ? enrollmentAction(enrollment) : '报名';
  return <Modal title={`${action} · ${period.name}`} open onCancel={close} maskClosable={false} footer={null}>
    <Load query={details}>{([context, record]) => (
      <EnrollmentForm context={context} enrollment={record} onSaved={() => { close(); details.refresh(); }} />
    )}</Load>
  </Modal>;
}

function WorkChoices({ works, value, onChange, proxy }) {
  function update(work, patch) {
    const current = value.find(w => w.workTypeId === work.id);
    onChange(value.map(w => w === current ? { ...w, ...patch } : w));
  }
  return <div className="stack">{works.map(w => {
    const chosen = value.find(a => a.workTypeId === w.id);
    const days = openDays(w);
    const selectedDays = chosen?.weekdays ?? days;
    const initialDays = days.length === 1 ? days : [];
    const allSelected = selectedDays.length === days.length;
    return <div className="choice" key={w.id}>
      <Checkbox checked={!!chosen} disabled={!chosen && !days.length} onChange={e => onChange(e.target.checked
        ? [...value, { workTypeId: w.id, priority: 1, dutyRole: w.requiresRoles ? undefined : 'member', weekdays: w.allowWeekdaySelection ? initialDays : undefined }]
        : value.filter(a => a.workTypeId !== w.id))}>{w.name}</Checkbox>
      {(!chosen || !w.allowWeekdaySelection) && days.length < 7 && <div className="muted">{days.map(d => weekdays[d]).join('、') || '未设置工作日'}</div>}
      {chosen && <div className="enrollment-work-fields">
        {w.allowWeekdaySelection && <Form.Item className="enrollment-work-field enrollment-weekday-field" layout="horizontal" label="报名星期" colon={false}>
          <Checkbox.Group className="enrollment-weekday-options" role="group" aria-label={w.name + '报名星期'}
            value={selectedDays} onChange={nextDays => update(w, { weekdays: nextDays })}>
            {days.map(day => <Checkbox key={day} value={day}>{weekdays[day]}</Checkbox>)}
            {days.length > 1 && <Button type="link" size="small" onClick={() => update(w, { weekdays: allSelected ? [] : days })}>
              {allSelected ? '清空' : '全选'}
            </Button>}
          </Checkbox.Group>
        </Form.Item>}
        {!proxy && <Form.Item className="enrollment-work-field" layout="horizontal" label="意愿" colon={false}>
          <Select aria-label={w.name + '意愿'} value={chosen.priority} onChange={priority => update(w, { priority })} options={[1, 2, 3].map(n => option(n, n === 1 ? '1 级（最优先）' : n + ' 级'))} />
        </Form.Item>}
        {w.requiresRoles && <Form.Item className="enrollment-work-field" layout="horizontal" label="报名角色" colon={false}>
          <Select aria-label={w.name + '报名角色'} value={chosen.dutyRole} placeholder="选择主副角色" onChange={dutyRole => update(w, { dutyRole })} options={roleOptions('primary', 'deputy', 'both')} />
        </Form.Item>}
      </div>}
    </div>;
  })}</div>;
}

const availabilityLabels = { full: '全部可用', partial: '部分可用', none: '整天不可用' };

function AvailabilityCalendar({ dates, shifts, available, reasons, setAvailable, setReasons }) {
  const [month, setMonth] = useState(monthOf(dates[0]));
  const [date, setDate] = useState(null);
  if (!dates.length || !shifts.length) return <Blank>暂无可设置的班次</Blank>;
  const allShifts = shifts.map(shift => shift.id);
  function dayInfo(day) {
    const slots = available[day];
    if (!slots) return undefined;
    const status = !slots.length ? 'none' : slots.length === shifts.length ? 'full' : 'partial';
    return { label: availabilityLabels[status], badge: <i className={`availability-dot availability-${status}`} aria-hidden="true" /> };
  }
  function updateShifts(ids) {
    setAvailable(previous => ({ ...previous, [date]: ids }));
  }
  return <div className="stack">
    <MonthCalendar month={month} startDate={dates[0]} endDate={dates.at(-1)} move={setMonth} selected={date} pick={setDate}
      blocked={day => !available[iso(day)]} dayInfo={dayInfo} />
    <div className="availability-legend">{Object.entries(availabilityLabels).map(([status, label]) => (
      <span key={status}><i className={`availability-dot availability-${status}`} aria-hidden="true" />{label}</span>
    ))}</div>
    <Modal open={!!date} title={date && `${dateText(date)} · 可用时间`} onCancel={() => setDate(null)}
      footer={<Button type="primary" onClick={() => setDate(null)}>完成</Button>}>
      {date && <div className="stack">
        <Checkbox checked={!available[date].length} onChange={event => updateShifts(event.target.checked ? [] : allShifts)}>整天不可用</Checkbox>
        <Checkbox.Group className="schedule-weekdays" aria-label="可用班次" value={available[date]}
          onChange={updateShifts} options={shifts.map(shift => option(shift.id, shiftText(shift)))} />
        {!available[date].length && <Input maxLength={200} aria-label="请假原因" placeholder="请假原因（可选）"
          value={reasons[date] || ''} onChange={event => setReasons(previous => ({ ...previous, [date]: event.target.value }))} />}
      </div>}
    </Modal>
  </div>;
}

function EnrollmentForm({ context, enrollment, onSaved, proxyUser }) {
  const { message } = App.useApp();
  const { run, busy, confirm } = useAction();
  const [work, setWork] = useState(() => enrollment.workTypes.flatMap(w => {
    const config = context.workTypes.find(c => c.id === w.workTypeId);
    if (!config) return [];
    return [{
      ...w,
      dutyRole: config.requiresRoles && w.dutyRole === 'member' ? undefined : w.dutyRole,
      weekdays: config.allowWeekdaySelection ? w.weekdays?.filter(day => config.weekdays.includes(day)) : undefined,
    }];
  }));
  const [note, setNote] = useState(enrollment.note || '');
  const [reasons, setReasons] = useState(() => Object.fromEntries(enrollment.unavailability.map(a => [a.workDate, a.reason || ''])));
  const [available, setAvailable] = useState(() => enrollmentAvailability(context, enrollment));
  const published = context.period.status === 'published';
  const editable = proxyUser ? context.period.status !== 'archived' : canEnroll(context.period);
  const submitLabel = proxyUser ? '提交代报名' : enrollment.status === 'submitted' ? '保存修改' : '提交报名';
  async function save() {
    if (!work.length && !enrollment.submittedWorkTypeIds?.length && !enrollment.withdrawnWorkTypeIds?.length && !context.fixedAssignments?.length) return message.error('请至少选择一项工作');
    if (work.some(w => !(w.weekdays ?? context.workTypes.find(c => c.id === w.workTypeId).weekdays).length)) return message.error('请为每项报名工作至少选择一天');
    if (work.some(w => !w.dutyRole)) return message.error('请选择主副角色');
    if (!await checkRemoval(context, enrollment, work, confirm)) return;
    if (proxyUser) return run(() => API.saveAdminEnrollment(context.period.id, proxyUser, { workTypes: work }), savedEnrollment, onSaved);
    const availability = [], unavailability = [];
    for (const [workDate, shifts] of Object.entries(available)) {
      if (!shifts.length) unavailability.push({ workDate, reason: reasons[workDate]?.trim() || null });
      else shifts.forEach(shiftId => availability.push({ workDate, shiftId }));
    }
    return run(() => API.saveEnrollment(context.period.id, { workTypes: work, maxShifts: enrollment.maxShifts, availability, unavailability, note }), savedEnrollment, onSaved);
  }
  return <div className="stack">
    <Space wrap><EnrollmentStatus enrollment={enrollment} /><span className="muted">{context.period.startDate} 至 {context.period.endDate}</span></Space>
    {!editable ? <Alert message="当前仅供查看" /> : published && <Alert message="报名可补近 7 天空位；按报名安排的工作可加入本周期剩余班次。取消后会移除明天起的对应安排。" />}
    {!proxyUser && context.fixedAssignments?.length > 0 && <Collapse size="small" items={[{ key: 'fixed', label: '长期固定安排', children: context.fixedAssignments.map((a, i) => <div key={i}>{a.workTypeName} · {weekdays[a.weekday]} · {a.shiftName} · {roleLabels[a.dutyRole]}</div>) }]} />}
    <Form layout="vertical" disabled={!editable || busy} onFinish={save}>
      <h3>报名工作</h3><WorkChoices works={context.workTypes} value={work} onChange={setWork} proxy={proxyUser} />
      {!context.workTypes.length && <Blank>暂无可报名工作</Blank>}
      {!proxyUser && <>
        <Collapse className="form-section compact-calendar" items={[{
          key: 'available', label: '可用时间', extra: <span onClick={e => e.stopPropagation()}><Help name="availability" /></span>,
          children: <AvailabilityCalendar dates={context.dates} shifts={context.shifts} available={available} reasons={reasons} setAvailable={setAvailable} setReasons={setReasons} />,
        }]} />
        <Field label="备注"><Input.TextArea aria-label="备注" maxLength={1000} rows={2} value={note} onChange={e => setNote(e.target.value)} /></Field>
      </>}
      {editable && <Button type="primary" htmlType="submit" loading={busy} disabled={!context.dates.length || !context.shifts.length}>{submitLabel}</Button>}
    </Form>
  </div>;
}

export function ProxyEnrollment({ period, currentUserId, close, saved }) {
  const [person, setPerson] = useState();
  const users = useLoad('users', API.adminUsers);
  const data = useLoad(person, () => API.adminEnrollment(period.id, person));
  return <Modal title={<>代报名 <Help name="proxy" /></>} open onCancel={close} footer={null}>
    <Load query={users}>{items => <Form layout="vertical"><Field label="人员"><Select aria-label="人员" showSearch optionFilterProp="label" placeholder="选择人员" options={items.filter(u => u.status === 'active').map(u => option(u.id, personLabel(u, currentUserId)))} value={person} onChange={setPerson} /></Field></Form>}</Load>
    {person && <Load query={data}>{({ context, enrollment }) => <EnrollmentForm key={person} context={context} enrollment={enrollment} proxyUser={person} onSaved={saved} />}</Load>}
  </Modal>;
}
