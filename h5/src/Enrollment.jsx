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
import { API, Blank, Field, Heading, Help, Load, checkRemoval, dateText, monthOf, option, periodOptions, personLabel, roleLabels, roleOptions, savedEnrollment, shiftText, timeText, useAction, useLoad, weekdays } from './shared';

const canEnroll = period => ['enrolling', 'scheduling', 'published'].includes(period?.status);

function enrollmentAction(enrollment) {
  return enrollment.exists ? '修改报名信息' : '打开报名表';
}

function EnrollmentStatus({ enrollment }) {
  const submitted = enrollment.status === 'submitted';
  const label = submitted ? '已提交' : enrollment.exists ? '草稿' : '尚未报名';
  return <Tag color={submitted ? 'green' : 'default'}>{label}</Tag>;
}

export function Enrollment({ periods, period }) {
  const options = [...periods].sort((a, b) => Number(canEnroll(b)) - Number(canEnroll(a)));
  const [selected, setSelected] = useState();
  const [openPeriod, setOpenPeriod] = useState(null);
  const selection = options.find(p => p.id === selected)
    || options.find(p => p.id === period?.id && canEnroll(p))
    || options[0];
  const enrollmentPeriodId = openPeriod?.id ?? selection?.id;
  const details = useLoad(enrollmentPeriodId, () => Promise.all([
    API.enrollContext(enrollmentPeriodId),
    API.myEnrollment(enrollmentPeriodId),
  ]));

  return <>
    <Card><Heading help="enroll">我的报名</Heading>
      {selection ? <>
        <Form layout="vertical">
          <Field label="排班周期">
            <Select aria-label="排班周期" value={selection.id} onChange={setSelected} options={periodOptions(options)} />
          </Field>
        </Form>
        <div className="muted">{selection.startDate} 至 {selection.endDate}</div>
      </> : <Blank>暂无报名周期</Blank>}
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
    {enrollment.exists && <>
      {enrollment.status === 'submitted' && <div className="enrollment-summary muted">
        {enrollment.submittedAt && <p>提交时间：{timeText(enrollment.submittedAt)}</p>}
        {enrollment.submittedByName && <p>代报名人：{enrollment.submittedByName}</p>}
      </div>}
      <section>
        <h3>报名工作</h3>
        {enrollment.workTypes.length ? enrollment.workTypes.map(work => (
          <div className="choice row-between enrollment-summary" key={work.workTypeId}>
            <strong>{work.name}</strong>
            <Space wrap size={[4, 4]}>
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
    return <div className="choice" key={w.id}>
      <Checkbox checked={!!chosen} onChange={e => onChange(e.target.checked ? [...value, { workTypeId: w.id, priority: 1, dutyRole: w.requiresRoles ? undefined : 'member' }] : value.filter(a => a.workTypeId !== w.id))}>{w.name}</Checkbox>
      {w.weekdays?.length < 7 && <div className="muted">{w.weekdays.map(d => weekdays[d]).join('、') || '未设置工作日'}</div>}
      {chosen && <div className="form-grid">
        {!proxy && <Field label="意愿"><Select aria-label={w.name + '意愿'} value={chosen.priority} onChange={priority => update(w, { priority })} options={[1, 2, 3].map(n => option(n, n === 1 ? '1 级（最优先）' : n + ' 级'))} /></Field>}
        {w.requiresRoles && <Field label="报名角色"><Select aria-label={w.name + '报名角色'} value={chosen.dutyRole} placeholder="选择主副角色" onChange={dutyRole => update(w, { dutyRole })} options={roleOptions('primary', 'deputy', 'both')} /></Field>}
      </div>}
    </div>;
  })}</div>;
}

function EnrollmentForm({ context, enrollment, onSaved, proxyUser }) {
  const { message } = App.useApp();
  const { run, busy, confirm } = useAction();
  const [work, setWork] = useState(() => enrollment.workTypes.filter(w => context.workTypes.some(c => c.id === w.workTypeId)));
  const [note, setNote] = useState(enrollment.note || '');
  const [month, setMonth] = useState(monthOf(context.dates[0]));
  const [reasons, setReasons] = useState(() => Object.fromEntries(enrollment.unavailability.map(a => [a.workDate, a.reason || ''])));
  const [available, setAvailable] = useState(() => enrollmentAvailability(context, enrollment));
  const published = context.period.status === 'published';
  const editable = proxyUser ? context.period.status !== 'archived' : canEnroll(context.period);
  const submitLabel = proxyUser ? '提交代报名' : enrollment.status === 'submitted' ? '保存修改' : '提交报名';
  async function save(submit) {
    if (submit && !work.length && !enrollment.submittedWorkTypeIds?.length && !enrollment.withdrawnWorkTypeIds?.length && !context.fixedAssignments?.length) return message.error('请至少选择一项工作');
    if (submit && work.some(w => !w.dutyRole)) return message.error('请选择主副角色');
    if (submit && !await checkRemoval(context, enrollment, work, confirm)) return;
    if (proxyUser) return run(() => API.saveAdminEnrollment(context.period.id, proxyUser, { workTypes: work }), savedEnrollment, onSaved);
    const availability = [], unavailability = [];
    for (const [workDate, shifts] of Object.entries(available)) {
      if (!shifts.length) unavailability.push({ workDate, reason: reasons[workDate]?.trim() || null });
      else shifts.forEach(shiftId => availability.push({ workDate, shiftId }));
    }
    return run(() => API.saveEnrollment(context.period.id, { workTypes: work.map(w => ({ ...w, dutyRole: w.dutyRole || 'member' })), maxShifts: enrollment.maxShifts, availability, unavailability, note, submit }), submit ? savedEnrollment : '草稿已保存', onSaved);
  }
  return <div className="stack">
    <Space wrap><EnrollmentStatus enrollment={enrollment} /><span className="muted">{context.period.startDate} 至 {context.period.endDate}</span></Space>
    {!editable ? <Alert message="当前仅供查看" /> : published && <Alert message="提交后可补近7天空位；取消工作会移除明天起的对应安排。" />}
    {!proxyUser && context.fixedAssignments?.length > 0 && <Collapse size="small" items={[{ key: 'fixed', label: '长期固定安排', children: context.fixedAssignments.map((a, i) => <div key={i}>{a.workTypeName} · {weekdays[a.weekday]} · {a.shiftName} · {roleLabels[a.dutyRole]}</div>) }]} />}
    <Form layout="vertical" disabled={!editable || busy} onFinish={() => save(true)}>
      <h3>报名工作</h3><WorkChoices works={context.workTypes} value={work} onChange={setWork} proxy={proxyUser} />
      {!context.workTypes.length && <Blank>暂无可报名工作</Blank>}
      {!proxyUser && <>
        <Collapse className="form-section" items={[{ key: 'available', label: '可用时间', extra: <span onClick={e => e.stopPropagation()}><Help name="availability" /></span>, children: <>
          <Field label="查看月份"><Select aria-label="查看月份" value={month} onChange={setMonth} options={[...new Set(context.dates.map(monthOf))].map(m => option(m, m))} /></Field>
          <div className="stack">{context.dates.filter(d => monthOf(d) === month).map(d => <div className="choice" key={d}>
            <div className="row-between"><strong>{dateText(d)}</strong><Checkbox checked={!available[d].length} onChange={e => setAvailable(prev => ({ ...prev, [d]: e.target.checked ? [] : context.shifts.map(s => s.id) }))}>整天不可用</Checkbox></div>
            <Checkbox.Group value={available[d]} onChange={ids => setAvailable(prev => ({ ...prev, [d]: ids }))} options={context.shifts.map(s => option(s.id, shiftText(s)))} />
            {!available[d].length && <Input maxLength={200} aria-label={d + '请假原因'} placeholder="请假原因（可选）" value={reasons[d]} onChange={e => setReasons(prev => ({ ...prev, [d]: e.target.value }))} />}
          </div>)}</div>
        </> }]} />
        <Field label="备注"><Input.TextArea aria-label="备注" maxLength={1000} rows={2} value={note} onChange={e => setNote(e.target.value)} /></Field>
      </>}
      {editable && <Space wrap>{!proxyUser && <Button onClick={() => save(false)} loading={busy}>保存草稿</Button>}<Button type="primary" htmlType="submit" loading={busy} disabled={!context.dates.length || !context.shifts.length}>{submitLabel}</Button></Space>}
    </Form>
  </div>;
}

export function ProxyEnrollment({ period, close, saved }) {
  const [person, setPerson] = useState();
  const users = useLoad('users', API.adminUsers);
  const data = useLoad(person, () => API.adminEnrollment(period.id, person));
  return <Modal title={<>代报名 <Help name="proxy" /></>} open onCancel={close} footer={null}>
    <Load query={users}>{items => <Form layout="vertical"><Field label="人员"><Select aria-label="人员" showSearch optionFilterProp="label" placeholder="选择人员" options={items.filter(u => u.status === 'active').map(u => option(u.id, personLabel(u)))} value={person} onChange={setPerson} /></Field></Form>}</Load>
    {person && <Load query={data}>{({ context, enrollment }) => <EnrollmentForm key={person} context={context} enrollment={enrollment} proxyUser={person} onSaved={saved} />}</Load>}
  </Modal>;
}
