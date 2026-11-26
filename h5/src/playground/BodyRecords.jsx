import React, { useEffect, useRef, useState } from 'react';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import DatePicker from 'antd/es/date-picker';
import Form from 'antd/es/form';
import InputNumber from 'antd/es/input-number';
import Pagination from 'antd/es/pagination';
import Space from 'antd/es/space';
import Tag from 'antd/es/tag';
import { API, Blank, Heading, Load, dateText, dayjs, iso, useAction, useLoad, usePageLoad } from '../shared';
import { bodyTrend } from './bodyTrend.mjs';

export default function BodyRecords({ today }) {
  const [form] = Form.useForm(), { message } = App.useApp(), { run, busy, confirm } = useAction();
  const [date, setDate] = useState(today), [range, setRange] = useState([iso(dayjs(today).subtract(89, 'day')), today]), [page, setPage] = useState(1);
  const editor = useRef(null);
  const history = usePageLoad(`body-records-${range.join(':')}`, () => API.bodyRecords({ from: range[0], to: range[1] }), true);
  const detail = useLoad(`body-record-day-${date}`, () => API.bodyRecords({ from: date, to: date }));
  const entry = detail.data?.items[0];
  useEffect(() => {
    if (detail.data) form.setFieldsValue({ weight: detail.data.items[0]?.weight ?? null, bodyFat: detail.data.items[0]?.bodyFat ?? null });
  }, [detail.data, form]);
  function selectDate(value) {
    if (value === date) {
      form.setFieldsValue({ weight: entry?.weight ?? null, bodyFat: entry?.bodyFat ?? null });
      return;
    }
    setDate(value);
    form.setFieldsValue({ weight: null, bodyFat: null });
  }
  function refresh() { history.refresh(); detail.refresh(); setPage(1); }
  function save(values) {
    return run(async () => {
      if (values.weight == null && values.bodyFat == null) throw new Error('请至少填写体重或体脂率中的一项');
      return API.saveBodyRecord(date, { weight: values.weight, bodyFat: values.bodyFat });
    }, '身体记录已保存', () => {
      if (date < range[0] || date > range[1]) setRange([iso(dayjs(date).subtract(89, 'day')), date]);
      refresh();
    });
  }
  function edit(record) {
    selectDate(record.date);
    editor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function remove(record) {
    if (await confirm('删除这条身体记录？', `${record.date} 的体重、体脂率记录将删除。`, true, '删除')) {
      run(() => API.removeBodyRecord(record.id), '身体记录已删除', refresh);
    }
  }
  return <div className="stack body-records">
    <Card className="body-record-editor" ref={editor}><div className="row-between"><Heading>身体记录</Heading><Tag color="purple">🔒 仅自己可见</Tag></div>
      <Form form={form} layout="vertical" onFinish={save} disabled={busy || detail.loading}>
        <Form.Item label="记录日期" required><DatePicker value={dayjs(date)} allowClear={false} inputReadOnly disabledDate={d => iso(d) > today || iso(d) < '1900-01-01'} onChange={d => selectDate(iso(d))} style={{ width: '100%' }} /></Form.Item>
        <div className="exercise-form-grid">
          <Form.Item label="体重（kg）" name="weight"><InputNumber min={0.1} max={1000} precision={1} placeholder="例如：65.5" style={{ width: '100%' }} /></Form.Item>
          <Form.Item label="体脂率（%）" name="bodyFat"><InputNumber min={0.1} max={99.9} precision={1} placeholder="例如：22.5" style={{ width: '100%' }} /></Form.Item>
        </div>
        <div className="body-record-hint"><small className="muted">两项至少填写一项。同一天保留一条记录，保存后更新当天数值。</small>
          {detail.error && <small role="alert">读取当天记录失败：{detail.error.message} <Button type="link" size="small" onClick={detail.refresh}>重试</Button></small>}
          {entry && <small className="muted">已载入 {dateText(date)} 的记录，可直接修改。</small>}
        </div>
        <Button type="primary" htmlType="submit" disabled={detail.loading || !!detail.error} loading={busy}>保存身体记录</Button>
      </Form>
    </Card>
    <Card><div className="stack"><Heading>变化趋势</Heading>
      <div className="body-range"><label htmlFor="body-record-range">查看时间</label><DatePicker.RangePicker id="body-record-range" allowClear={false} inputReadOnly value={range.map(d => dayjs(d))} style={{ width: '100%' }}
        presets={[30, 90, 365].map(days => ({ label: `近 ${days} 天`, value: [dayjs(today).subtract(days - 1, 'day'), dayjs(today)] }))}
        disabledDate={d => iso(d) > today || iso(d) < '1900-01-01'} onChange={dates => {
          if (!dates) return;
          if (dates[1].diff(dates[0], 'day') > 365) { message.warning('单次最多查看 366 天，请缩小时间范围'); return; }
          setRange(dates.map(iso)); setPage(1);
        }} /></div>
      <Load query={history}>{data => <>
        <div className="body-trends"><Trend key={`weight:${range}`} items={data.items} field="weight" title="体重" unit="kg" />
          <Trend key={`fat:${range}`} items={data.items} field="bodyFat" title="体脂率" unit="%" /></div>
        <small className="muted">纵轴按记录范围缩放；未填写的指标不计为 0。点击图中节点可查看数值。</small>
      </>}</Load>
    </div></Card>
    <Card><div className="stack"><div className="row-between"><Heading>记录明细</Heading>{history.data && <small className="muted">当前范围 {history.data.items.length} 条</small>}</div>
      <Load query={history}>{data => {
        const records = [...data.items].reverse();
        return <>{records.length ? records.slice((page - 1) * 10, page * 10).map(record => <article className="exercise-record exercise-private" key={record.id}>
          <div className="row-between"><strong>{dateText(record.date)}</strong><Space><Button size="small" type="text" disabled={busy} onClick={() => edit(record)}>修改</Button><Button size="small" type="text" disabled={busy} onClick={() => remove(record)}>删除</Button></Space></div>
          <div className="body-record-values"><span>体重 <b>{record.weight == null ? '未填写' : `${record.weight.toFixed(1)} kg`}</b></span><span>体脂率 <b>{record.bodyFat == null ? '未填写' : `${record.bodyFat.toFixed(1)}%`}</b></span></div>
        </article>) : <Blank>当前时间范围内还没有身体记录</Blank>}
          <Pagination size="small" current={page} pageSize={10} total={records.length} onChange={setPage} hideOnSinglePage showSizeChanger={false} />
        </>;
      }}</Load>
    </div></Card>
  </div>;
}
function Trend({ items, field, title, unit }) {
  const series = bodyTrend(items, field), [selectedDate, setSelectedDate] = useState(null);
  const selected = series?.points.find(p => p.date === selectedDate) || series?.points.at(-1);
  return <section className={`body-trend body-trend-${field}`} aria-label={`${title}变化`}>
    <div className="row-between"><h3>{title}</h3>{series && <strong>{series.last.value.toFixed(1)} <small>{unit}</small></strong>}</div>
    {!series ? <Blank>还没有{title}数据</Blank> : <>
      <div className="body-trend-summary"><small className="muted">最近记录 {series.last.date}</small><small>{series.points.length < 2 ? '再记录一次即可查看变化' : `较区间首条 ${series.change > 0 ? '+' : ''}${series.change.toFixed(1)} ${field === 'bodyFat' ? '个百分点' : 'kg'}`}</small></div>
      <svg viewBox="0 0 600 200" role="group" aria-label={`${title}变化折线图，单位${unit}`}>
        {[series.high, (series.low + series.high) / 2, series.low].map((value, i) => { const y = 20 + i * 65; return <g key={i}><line x1="50" x2="580" y1={y} y2={y} stroke="#e3e9ee" strokeDasharray="4 4" /><text x="42" y={y + 4} textAnchor="end">{value.toFixed(1)}</text></g>; })}
        {series.points.length > 1 && <polyline points={series.points.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />}
        {series.points.map(point => <g key={point.date} role="button" tabIndex={0} aria-label={`${point.date}，${title} ${point.value.toFixed(1)} ${unit}`} aria-pressed={point.date === selected.date} onClick={() => setSelectedDate(point.date)} onKeyDown={e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); setSelectedDate(point.date); } }}>
          <circle cx={point.x} cy={point.y} r="12" fill="transparent" /><circle cx={point.x} cy={point.y} r={point.date === selected.date ? 5 : 3.5} fill="currentColor" stroke="white" strokeWidth="1.5" />
        </g>)}
        <text x="50" y="180">{series.first.date.slice(5)}</text><text x="580" y="180" textAnchor="end">{series.last.date.slice(5)}</text>
      </svg><div className="body-chart-selection" aria-live="polite">{selected.date} · {selected.value.toFixed(1)} {unit}</div>
    </>}
  </section>;
}
