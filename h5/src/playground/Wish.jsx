import React, { useRef, useState } from 'react';
import Alert from 'antd/es/alert';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Radio from 'antd/es/radio';
import Space from 'antd/es/space';
import { API, Load, useAction, useLoad } from '../shared';
export default function Wish({ balance, close, saved, openTopic }) {
  const meta = useLoad('wish-presets', API.wishPresets), [form] = Form.useForm();
  const [result, setResult] = useState(null), presetId = Form.useWatch('presetId', form);
  const requestKey = useRef(crypto.randomUUID()), { run, busy, confirm } = useAction();
  const { message } = App.useApp();
  async function submit(values) {
    const cost = meta.data.cost;
    if (!await confirm(`用 ${cost} 禾穗许下这个愿望？`, `确认后将扣除 ${cost} 禾穗，并以你的名字在互动区发布许愿话题。愿望不保证实现，消耗的禾穗不会退回。`, false, '确认许愿')) return;
    await run(() => API.makeWish({ ...values, requestKey: requestKey.current }), null, value => { setResult(value); saved(); if (value.replayed) message.info('这次许愿已处理，没有重复扣除禾穗'); });
  }
  return <Modal open title={result ? '愿望已送达' : '🌠 许一个愿望'} width={560} className="wish-modal" footer={null} onCancel={() => !busy && close()} maskClosable={!busy}>
    {result ? <div className="stack wish-success"><div className="wish-bloom" aria-hidden="true">🌠<span>✦</span><span>✧</span><span>✦</span></div><h2>{result.title}</h2><p>{result.topicId ? '你的心愿已发布到互动区。' : '这次愿望已经兑换，原话题已被删除。'}</p><Alert type="info" showIcon message="愿望不保证实现，大家可自愿回应。" /><p className="muted">消耗 {result.cost} 禾穗 · 当前还有 {result.balance} 禾穗</p><Space wrap>{result.topicId && <Button type="primary" onClick={() => { close(); openTopic(result.topicId); }}>查看许愿话题</Button>}<Button onClick={close}>完成</Button></Space></div> : <Load query={meta}>{data => <Form form={form} layout="vertical" initialValues={{ presetId: data.presets[0].id }} disabled={busy} onFinish={submit}>
      <Alert className="wish-disclaimer" type="warning" showIcon message={`每次许愿消耗 ${data.cost} 禾穗`} description="愿望不保证实现，大家可自愿回应。确认后会以你的名字发布到互动区，消耗的禾穗不退回。" />
      <p className="muted wish-current-balance">当前有 {balance} 禾穗</p>
      <Form.Item name="presetId" label="选择一份小心愿" rules={[{ required: true }]}><Radio.Group className="wish-presets">{data.presets.map(p => <Radio.Button key={p.id} value={p.id}><span aria-hidden="true">{p.icon}</span><span>{p.title}</span></Radio.Button>)}<Radio.Button value="custom"><span aria-hidden="true">✨</span><span>写下自己的愿望</span></Radio.Button></Radio.Group></Form.Item>
      {presetId === 'custom' && <Form.Item name="title" label="我的愿望" preserve={false} rules={[{ required: true, whitespace: true, message: '写下你想许的愿望' }]}><Input maxLength={60} showCount placeholder="希望有人和我一起……" /></Form.Item>}
      {presetId && presetId !== 'custom' && <p className="wish-preset-copy">{data.presets.find(p => p.id === presetId)?.content}</p>}
      <Form.Item className="wish-note" name="content" label="补充说明（选填）"><Input.TextArea rows={3} maxLength={1000} showCount placeholder="还想和大家说些什么？" /></Form.Item>
      <div className="wish-actions"><small className="muted">仅可从游乐场发起许愿话题</small><Button type="primary" htmlType="submit" loading={busy} disabled={balance < data.cost}>🌠 用 {data.cost} 禾穗许愿</Button></div>
      {balance < data.cost && <p className="muted wish-current-balance">禾穗还不够，先完成几场游戏再来吧。</p>}
    </Form>}</Load>}
  </Modal>;
}
