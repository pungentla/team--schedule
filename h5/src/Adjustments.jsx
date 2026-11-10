import React, { useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Form from 'antd/es/form';
import Modal from 'antd/es/modal';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import { API, Blank, Field, Load, dateText, option, personLabel, roleLabels, roleOptions, useAction, useLoad } from './shared';
import { problemsText, SwapForm } from './Swaps';

export function Adjustments({ mode, data, close, saved }) {
  return <Modal open title={mode === 'draft' ? '手工调配草稿' : '直接调整已发布排班'} onCancel={close} footer={null}>
    {mode === 'draft' ? <DraftEditor data={data} saved={saved} /> : <div className="stack"><Alert message="提交后立即生效，无需员工确认。" /><SwapForm assignments={data.assignments} admin saved={saved} /></div>}
  </Modal>;
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
      {cell.gap > 0 && <>
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
