import React, { useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Tag from 'antd/es/tag';
import { API, Blank, Field, Heading, Load, assignmentLabel, option, personLabel, swapLabels, useAction, useLoad } from './shared';

export const problemsText = items => (items || []).map(p => p.label || p.message || p.code).join('；');

export function SwapForm({ assignments, admin, saved }) {
  const [from, setFrom] = useState();
  const [type, setType] = useState('transfer');
  const [person, setPerson] = useState();
  const [target, setTarget] = useState();
  const [message, setMessage] = useState('');
  const query = useLoad(from, () => API.swapCandidates(from));
  const { run, busy, confirm } = useAction();
  const exchange = type === 'exchange';
  const candidate = query.data?.candidates.find(c => c.userId === person);
  const source = assignments.find(a => a.id === from);
  const targetAssignment = candidate?.theirAssignments.find(a => a.id === target);
  function change(setter, value) { setter(value); setPerson(undefined); setTarget(undefined); }
  async function submit() {
    if (!source || !candidate || (exchange && !targetAssignment)) return;
    if (admin && !await confirm('确认直接调班？', `${source.name}的 ${assignmentLabel(source)} 转交 ${candidate.name}${targetAssignment ? `；对方的 ${assignmentLabel(targetAssignment)} 转交 ${source.name}` : ''}。提交后立即生效。`)) return;
    const body = { type, fromAssignmentId: from, toUserId: person, toAssignmentId: exchange ? target : undefined, message: message.trim() };
    await run(() => admin ? API.adminReassign(body) : API.createSwap(body), admin ? '调配已生效' : '已发起申请，等待同事确认', data => { setFrom(undefined); setPerson(undefined); setTarget(undefined); setMessage(''); saved(data); });
  }
  if (!assignments.length) return <Blank>暂无可换班的已发布班次</Blank>;
  return <Form layout="vertical" disabled={busy} onFinish={submit}>
    <Field label={admin ? '需要调整的排班' : '我的班次'}><Select aria-label={admin ? '需要调整的排班' : '我的班次'} showSearch optionFilterProp="label" value={from} onChange={id => change(setFrom, id)} placeholder="选择班次" options={assignments.map(a => option(a.id, `${admin ? a.name : a.periodName} · ${assignmentLabel(a)}`))} /></Field>
    <Field label="换班方式"><Select aria-label="换班方式" value={type} onChange={v => change(setType, v)} options={[option('transfer', '转班'), option('exchange', '互换')]} /></Field>
    {from && <Load query={query}>{data => data.candidates.length ? <Field label={exchange ? '互换同事' : '接班同事'}><Select aria-label={exchange ? '互换同事' : '接班同事'} showSearch optionFilterProp="label" value={person} onChange={id => { setPerson(id); setTarget(undefined); }} placeholder="选择同事" options={data.candidates.map(c => ({ ...option(c.userId, personLabel(c) + (exchange ? (!c.theirAssignments.length ? ' · 无可交换班次' : '') : c.canTake ? '' : ' · ' + problemsText(c.problems))), disabled: exchange ? !c.theirAssignments.length : !c.canTake }))} /></Field> : <Blank>暂无可选择的同事</Blank>}</Load>}
    {exchange && candidate && <Field label="对方的班次"><Select aria-label="对方的班次" value={target} onChange={setTarget} placeholder="选择互换班次" options={candidate.theirAssignments.map(a => option(a.id, assignmentLabel(a)))} /></Field>}
    <Field label={admin ? '调配说明' : '给同事的留言'}><Input.TextArea aria-label={admin ? '调配说明' : '给同事的留言'} rows={2} maxLength={1000} value={message} onChange={e => setMessage(e.target.value)} /></Field>
    <Button type="primary" htmlType="submit" loading={busy} disabled={!candidate || (exchange && !targetAssignment)}>{admin ? '确认调整，立即生效' : '发起申请'}</Button>
  </Form>;
}

export function Swaps({ user, detail, setDetail, inbox }) {
  const assignments = useLoad('assignments', API.myAssignments);
  const requests = useLoad('requests', API.mySwaps);
  const refresh = () => { assignments.refresh(); requests.refresh(); inbox.refresh(); };
  return <>
    <Card><Heading help="swaps">发起换班</Heading><Load query={assignments}>{list => <SwapForm assignments={list.filter(a => a.periodStatus === 'published')} saved={result => { refresh(); setDetail(result.swap.id); }} />}</Load></Card>
    {[[inbox, '待我确认', '没有待你确认的申请'], [requests, '我发起的申请', '还没有发起过换班']].map(([query, title, empty]) =>
      <Load key={title} query={query}>{list => <Card title={title}>
      {list.length ? list.map(s => <div className="choice" key={s.id}>
        <div className="row-between"><strong>{s.requesterName} {s.type === 'exchange' ? '⇄' : '→'} {s.toUserName}</strong><Tag>{swapLabels[s.status]}</Tag></div>
        <div>{assignmentLabel(s.fromAssign)}</div>
        {s.toAssign && <div>互换：{assignmentLabel(s.toAssign)}</div>}
        <Button onClick={() => setDetail(s.id)}>{s.canAct ? '查看 / 处理' : '查看详情'}</Button>
      </div>) : <Blank>{empty}</Blank>}
    </Card>}</Load>)}
    {detail && <SwapDetail id={detail} user={user} close={() => setDetail(undefined)} saved={refresh} />}
  </>;
}

function SwapDetail({ id, user, close, saved }) {
  const query = useLoad(id, () => API.swapDetail(id));
  const [reason, setReason] = useState('');
  const { run, busy, confirm } = useAction();
  async function decide(action) {
    if (action !== 'confirm' && !await confirm(action === 'reject' ? '拒绝换班申请？' : '撤回换班申请？')) return;
    await run(() => API.decideSwap(id, action, reason.trim() || null),
      result => action === 'confirm' ? result.applied ? '换班已生效' : '已同意' : action === 'reject' ? '已拒绝申请' : '申请已撤回',
      () => { saved(); query.refresh(); });
  }
  return <Modal open title="换班详情" onCancel={close} footer={null}><Load query={query}>{d => {
    const pending = d.swap.status === 'pending', canDecide = pending && d.myDecision === 'pending';
    return <div className="stack">
      <div><Tag color={pending ? 'gold' : 'blue'}>{swapLabels[d.swap.status]}</Tag>{d.swap.requesterName} → {d.swap.toUserName}</div>
      <div>转出：{assignmentLabel(d.fromAssignment)}</div>
      {d.toAssignment && <div>互换：{assignmentLabel(d.toAssignment)}</div>}
      <div>留言：{d.swap.message || '无'}</div>
      <div>{d.participants.map(p => <Tag key={p.userId}>{p.name}{p.isMe ? '（我）' : ''}：{swapLabels[p.status]}</Tag>)}</div>
      {!!d.liveProblems.length && <Alert type="warning" message={problemsText(d.liveProblems)} />}
      {canDecide && <Input aria-label="拒绝原因" placeholder="拒绝原因（可选）" value={reason} maxLength={200} onChange={e => setReason(e.target.value)} />}
      <Space wrap>
        {canDecide && <><Button type="primary" disabled={!d.canConfirm} loading={busy} onClick={() => decide('confirm')}>同意换班</Button><Button danger disabled={busy} onClick={() => decide('reject')}>拒绝申请</Button></>}
        {pending && d.swap.requesterId === user.id && <Button danger loading={busy} onClick={() => decide('cancel')}>撤回申请</Button>}
      </Space>
    </div>;
  }}</Load></Modal>;
}
