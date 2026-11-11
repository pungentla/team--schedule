import React, { useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Form from 'antd/es/form';
import Modal from 'antd/es/modal';
import Segmented from 'antd/es/segmented';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import { API, Blank, Field, Load, dateText, dayjs, option, personLabel, required, roleLabels, roleOptions, today, useAction, useLoad } from './shared';
import { problemsText, SwapForm } from './Swaps';

export function Adjustments({ mode, data, target, close, saved }) {
  return <Modal open title={mode === 'draft' ? '手工调配草稿' : '直接调整已发布排班'} onCancel={close} footer={null}>
    {mode === 'draft' ? <DraftEditor data={data} saved={saved} /> : <PublishedEditor data={data} target={target} saved={saved} />}
  </Modal>;
}

function PublishedEditor({ data, target, saved }) {
  const day = data.matrix.find(item => item.workDate === target?.workDate);
  const shift = day?.shifts.find(item => item.shiftId === target?.shiftId);
  const cell = shift?.workTypes.find(item => item.workTypeId === target?.workTypeId);
  const assignments = data.assignments.filter(item => {
    if (target?.workDate && item.workDate !== target.workDate) return false;
    return !cell || (item.shiftId === target.shiftId && item.workTypeId === target.workTypeId);
  });
  const [action, setAction] = useState(() => {
    if (cell) return cell.gap > 0 ? 'fill' : assignments.length ? 'swap' : 'remove';
    return target?.workDate || !assignments.length ? 'add' : 'swap';
  });
  const settings = useLoad(action === 'add' ? data.period.id : null, () => Promise.all([API.requirements(data.period.id), API.shifts()]));
  if (target?.workTypeId && !cell) return <Blank>该工作已移除</Blank>;
  const options = cell ? [
    ...(cell.gap > 0 || cell.fillAllEnrolled ? [option('fill', '补人')] : []),
    ...(assignments.length ? [option('swap', '换班')] : []),
    option('remove', '删除工作'),
  ] : [
    { ...option('swap', '换班'), disabled: !assignments.length },
    option('add', '新增工作'),
    { ...option('remove', '删除工作'), disabled: !data.matrix.length },
  ];
  return <div className="stack">
    <Alert message="提交后立即生效，无需员工确认。" />
    {cell && <strong>{dateText(target.workDate)} · {shift.shiftName} · {cell.workTypeName}</strong>}
    <Segmented block aria-label="手动调班方式" value={action} onChange={setAction} options={options} />
    {action === 'swap' && <SwapForm assignments={assignments} initialAssignmentId={cell && assignments.length === 1 ? assignments[0].id : undefined} admin saved={saved} />}
    {action === 'fill' && cell && <FillPublishedWork data={data} target={target} cell={cell} saved={saved} />}
    {action === 'add' && <Load query={settings}>{([requirements, shifts]) =>
      <AddPublishedWork data={data} requirements={requirements} activeShifts={shifts.filter(shift => shift.active)} preferredDate={target?.workDate} saved={saved} />
    }</Load>}
    {action === 'remove' && <RemovePublishedWork data={data} target={target} saved={saved} />}
  </div>;
}

function FillPublishedWork({ data, target, cell, saved }) {
  const { run, busy } = useAction();
  const roles = !cell.fillAllEnrolled && cell.roleGaps.length >= cell.gap ? cell.roleGaps : ['primary', 'deputy'];
  const options = data.employees.filter(user => !cell.assigned.some(person => person.userId === user.id))
    .map(user => option(user.id, personLabel(user)));
  function submit({ userId, dutyRole }) {
    return run(() => API.adjustPublishedWork(data.run.id, {
      ...target, action: 'fill', revision: data.run.revision, people: [{ userId, dutyRole: cell.requiresRoles ? dutyRole : 'member' }],
    }), '补人已生效', saved);
  }
  return <Form layout="vertical" disabled={busy} initialValues={{ dutyRole: cell.requiresRoles ? cell.roleGaps[0] || 'primary' : 'member' }} onFinish={submit}>
    {cell.requiresRoles && <Form.Item name="dutyRole" label="岗位角色" rules={required}><Select options={roleOptions(...roles)} /></Form.Item>}
    <Form.Item name="userId" label="补充人员" rules={required}><Select showSearch optionFilterProp="label" options={options} /></Form.Item>
    <Button type="primary" htmlType="submit" loading={busy}>补人并生效</Button>
  </Form>;
}

function AddPublishedWork({ data, requirements, activeShifts, preferredDate, saved }) {
  const [form] = Form.useForm();
  const { run, busy } = useAction();
  const dates = requirements.dates.map(day => day.workDate);
  const initialDate = dates.includes(preferredDate) ? preferredDate : dates.includes(today()) ? today() : dates[0];
  const workDate = Form.useWatch('workDate', form) ?? initialDate;
  const shiftId = Form.useWatch('shiftId', form);
  const workTypeId = Form.useWatch('workTypeId', form);
  const existing = data.matrix.find(day => day.workDate === workDate)?.shifts.find(shift => shift.shiftId === shiftId)?.workTypes || [];
  const shifts = requirements.dates.find(day => day.workDate === workDate)?.shifts.filter(shift => activeShifts.some(active => active.id === shift.shiftId)) || [];
  const works = shiftId ? requirements.workTypes.filter(work => work.weekdays.includes(dayjs(workDate).day()) && !existing.some(cell => cell.workTypeId === work.id)) : [];
  const work = works.find(item => item.id === workTypeId);
  const peopleOptions = data.employees.map(user => option(user.id, personLabel(user)));
  function submit(values) {
    if (!work) return;
    const people = work.requiresRoles
      ? [{ userId: values.primary, dutyRole: 'primary' }, { userId: values.deputy, dutyRole: 'deputy' }]
      : values.members.map(userId => ({ userId, dutyRole: 'member' }));
    return run(() => API.adjustPublishedWork(data.run.id, {
      action: 'add', revision: data.run.revision, workDate, shiftId, workTypeId, people,
    }), '工作已新增并生效', saved);
  }
  if (!dates.length) return <Blank>没有可安排的日期</Blank>;
  return <Form form={form} layout="vertical" initialValues={{ workDate: initialDate }} disabled={busy} onFinish={submit}
    onValuesChange={changes => {
      if ('workDate' in changes) form.setFieldValue('shiftId', undefined);
      if ('workDate' in changes || 'shiftId' in changes) form.setFieldValue('workTypeId', undefined);
      if ('workDate' in changes || 'shiftId' in changes || 'workTypeId' in changes) form.setFieldsValue({ primary: undefined, deputy: undefined, members: undefined });
    }}>
    <Form.Item name="workDate" label="日期" rules={required}><Select options={dates.map(date => option(date, dateText(date)))} /></Form.Item>
    <Form.Item name="shiftId" label="班次" rules={required}><Select options={shifts.map(shift => option(shift.shiftId, shift.shiftName))} /></Form.Item>
    <Form.Item name="workTypeId" label="工作" rules={required}><Select disabled={!shiftId} options={works.map(item => option(item.id, item.name))} /></Form.Item>
    {shiftId && !works.length && <Blank>该班次没有可新增的工作</Blank>}
    {work && (work.requiresRoles ? <>
      <Form.Item name="primary" label="主负责人" rules={required}><Select showSearch optionFilterProp="label" options={peopleOptions} /></Form.Item>
      <Form.Item name="deputy" label="副负责人" rules={required}><Select showSearch optionFilterProp="label" options={peopleOptions} /></Form.Item>
    </> : <Form.Item name="members" label="安排人员" rules={required}>
      <Select mode="multiple" maxCount={99} optionFilterProp="label" options={peopleOptions} />
    </Form.Item>)}
    <Button type="primary" htmlType="submit" loading={busy} disabled={!work}>新增并生效</Button>
  </Form>;
}

function RemovePublishedWork({ data, target, saved }) {
  const [workDate, setWorkDate] = useState(target?.workDate || data.matrix[0]?.workDate);
  const [selected, setSelected] = useState(target?.workTypeId ? `${target.shiftId}|${target.workTypeId}` : undefined);
  const { run, busy, confirm } = useAction();
  const works = (data.matrix.find(day => day.workDate === workDate)?.shifts || []).flatMap(shift =>
    shift.workTypes.map(work => ({ ...work, id: `${shift.shiftId}|${work.workTypeId}`, shiftId: shift.shiftId, shiftName: shift.shiftName })));
  const work = works.find(item => item.id === selected);
  async function remove() {
    if (!work || !await confirm('删除这项工作？', `${dateText(workDate)} · ${work.shiftName} · ${work.workTypeName}。对应安排将立即移除。`, true)) return;
    await run(() => API.adjustPublishedWork(data.run.id, {
      action: 'remove', revision: data.run.revision, workDate, shiftId: work.shiftId, workTypeId: work.workTypeId,
    }), '工作已从生效排班移除', saved);
  }
  return <Form layout="vertical" disabled={busy} onFinish={remove}>
    {!target?.workTypeId && <>
      <Field label="日期"><Select aria-label="日期" value={workDate} onChange={date => { setWorkDate(date); setSelected(undefined); }}
      options={data.matrix.map(day => option(day.workDate, dateText(day.workDate)))} /></Field>
      <Field label="班次与工作"><Select aria-label="班次与工作" value={selected} onChange={setSelected}
      options={works.map(item => option(item.id, `${item.shiftName} · ${item.workTypeName}（${item.filled} 人）`))} /></Field>
    </>}
    <Button danger type="primary" htmlType="submit" loading={busy} disabled={!work}>删除工作</Button>
  </Form>;
}

function DraftEditor({ data, saved }) {
  const days = data.matrix.filter(d => d.shifts.some(s => s.workTypes.length));
  const [date, setDate] = useState(data.gaps?.fixedConflicts?.[0]?.workDate || days[0]?.workDate);
  const [cellId, setCellId] = useState();
  const [role, setRole] = useState('primary');
  const [target, setTarget] = useState(null);
  const [person, setPerson] = useState();
  const { run, busy, confirm } = useAction();
  const cells = (days.find(d => d.workDate === date)?.shifts || []).flatMap(s => s.workTypes.map(w => ({ ...w, cellId: `${s.shiftId}|${w.workTypeId}`, shiftId: s.shiftId, shiftName: s.shiftName })));
  const cell = cells.find(w => w.cellId === cellId) || cells[0];
  const query = useLoad(target ? JSON.stringify([data.run.id, data.run.revision, target]) : null, () => API.draftCandidates(data.run.id, target));
  function change(next) { setTarget(next); setPerson(undefined); }
  function save(body) {
    return run(() => API.adjustDraft(data.run.id, body), '草稿已更新，发布后生效', result => { change(null); saved(result); });
  }
  if (!days.length) return <Blank>没有可调配的工作</Blank>;
  return <Form layout="vertical" disabled={busy} onFinish={() => person && save({ ...target, action: target.assignmentId ? 'replace' : 'add', userId: person, revision: query.data.revision })}>
    <Field label="日期"><Select aria-label="日期" value={date} onChange={d => { setDate(d); setCellId(undefined); change(null); }} options={days.map(d => option(d.workDate, dateText(d.workDate)))} /></Field>
    <Field label="班次与工作"><Select aria-label="班次与工作" value={cell?.cellId} onChange={v => { setCellId(v); change(null); }} options={cells.map(w => option(w.cellId, `${w.shiftName} · ${w.workTypeName}（${w.filled}/${w.needCount}）`))} /></Field>
    {cell && <div className="stack">
      <h3>当前人员（{cell.filled}/{cell.needCount}）</h3>
      {cell.assigned.map(a => <div className="choice" key={a.id}><div>{a.name} · {roleLabels[a.dutyRole]}{a.isFixed ? ' · 固定人员' : ''}</div>
        <Space wrap><Button onClick={() => change({ assignmentId: a.id })}>替换人员</Button>
          <Button danger onClick={async () => { if (await confirm('移除此班安排？', a.name, true)) await save({ action: 'remove', assignmentId: a.id, revision: data.run.revision }); }}>移除</Button></Space>
      </div>)}
      {(cell.gap > 0 || cell.fillAllEnrolled) && <>
        {cell.requiresRoles && <Field label="补充岗位角色"><Select aria-label="补充岗位角色" value={role} onChange={setRole} options={roleOptions('primary', 'deputy')} /></Field>}
        <Button onClick={() => change({ workDate: date, shiftId: cell.shiftId, workTypeId: cell.workTypeId, dutyRole: cell.requiresRoles ? role : 'member' })}>＋ 补充人员</Button>
      </>}
      {target && <Load query={query}>{result => <>
        <Field label="新人员"><Select aria-label="新人员" showSearch optionFilterProp="label" value={person} onChange={setPerson} options={result.candidates.map(u => ({ ...option(u.userId, personLabel(u) + (u.canAssign ? '' : ' · ' + problemsText(u.problems))), disabled: !u.canAssign }))} /></Field>
        <Button type="primary" htmlType="submit" disabled={!person} loading={busy}>确认修改草稿</Button>
      </>}</Load>}
    </div>}
  </Form>;
}
