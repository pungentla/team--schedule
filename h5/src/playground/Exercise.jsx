import React, { useRef, useState } from 'react';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import DatePicker from 'antd/es/date-picker';
import Form from 'antd/es/form';
import Image from 'antd/es/image';
import Input from 'antd/es/input';
import InputNumber from 'antd/es/input-number';
import Modal from 'antd/es/modal';
import Pagination from 'antd/es/pagination';
import Progress from 'antd/es/progress';
import Radio from 'antd/es/radio';
import Segmented from 'antd/es/segmented';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Switch from 'antd/es/switch';
import Tag from 'antd/es/tag';
import TimePicker from 'antd/es/time-picker';
import Upload from 'antd/es/upload';
import HeartOutlined from '@ant-design/icons/es/icons/HeartOutlined';
import HeartFilled from '@ant-design/icons/es/icons/HeartFilled';
import SettingOutlined from '@ant-design/icons/es/icons/SettingOutlined';
import PlusOutlined from '@ant-design/icons/es/icons/PlusOutlined';
import { API, PageBack, Blank, Heading, Load, dateText, dayjs, iso, monthOf, personName, timeText, useAction, useLoad, usePageLoad } from '../shared';
import { MonthCalendar } from '../MonthCalendar';
import { encodeImage } from '../images';
import { RewardReceipt } from './Harvest';
import { randomInt } from './random.mjs';
import './exercise.css';

const verses = [
  { text: '所以，要在你们的身子上荣耀神。', ref: '哥林多前书 6:20（节选）', url: 'https://www.bible.com/zh-CN/bible/48/1CO.6.20' },
  { text: '我愿你凡事兴盛，身体健壮，正如你的灵魂兴盛一样。', ref: '约翰三书 1:2（节选）', url: 'https://www.bible.com/zh-CN/bible/48/3JN.1.2' },
  { text: '从来没有人恨恶自己的身子，总是保养顾惜。', ref: '以弗所书 5:29（节选）', url: 'https://www.bible.com/zh-CN/bible/48/EPH.5.29' },
  { text: '你们来，同我暗暗地到旷野地方去歇一歇。', ref: '马可福音 6:31（节选）', url: 'https://www.bible.com/zh-CN/bible/48/MRK.6.31' },
  { text: '所以，你们或吃或喝，无论做什么，都要为荣耀神而行。', ref: '哥林多前书 10:31', url: 'https://www.bible.com/zh-CN/bible/48/1CO.10.31' },
  { text: '将身体献上，当作活祭，是圣洁的，是神所喜悦的。', ref: '罗马书 12:1（节选）', url: 'https://www.bible.com/zh-CN/bible/48/ROM.12.1' },
  { text: '我要称谢你，因我受造，奇妙可畏。', ref: '诗篇 139:14（节选）', url: 'https://www.bible.com/zh-CN/bible/48/PSA.139.14' },
  { text: '操练身体，益处还少；惟独敬虔，凡事都有益处。', ref: '提摩太前书 4:8（节选）', url: 'https://www.bible.com/zh-CN/bible/48/1TI.4.8' },
];
function Verse() {
  const [verse] = useState(() => verses[randomInt(verses.length)]);
  return <aside className="exercise-verse" aria-label="珍惜身体的经文"><span aria-hidden="true">🌿</span><div><p>{verse.text}</p><a href={verse.url} target="_blank" rel="noreferrer">{verse.ref}</a></div></aside>;
}
export default function Exercise({ user, back }) {
  const [tab, setTab] = useState('today'), [editing, setEditing] = useState(false), [revision, setRevision] = useState(0);
  const query = usePageLoad(`exercise-meta-${user.id}`, API.exerciseMeta, true);
  function refresh() { query.refresh(); setRevision(v => v + 1); }
  return <div className="stack exercise"><PageBack onClick={back}>返回游乐场</PageBack>
    <Card><div className="row-between"><Heading>🏃 一起动起来</Heading><Button icon={<SettingOutlined />} onClick={() => setEditing(true)}>目标与提醒</Button></div><Verse />
      <Load query={query}>{meta => <div className="exercise-week"><div className="row-between"><strong>本周已运动 {meta.weekDays.length} / {meta.settings.weeklyGoal} 天</strong><span className="muted">累计 {meta.weekMinutes} 分钟</span></div><Progress percent={Math.min(100, Math.round(meta.weekDays.length / meta.settings.weeklyGoal * 100))} showInfo={false} strokeColor="#409777" />
        <div className="exercise-footprints">{Array.from({ length: 7 }, (_, i) => { const date = iso(dayjs(meta.weekStart).add(i, 'day')), checked = meta.weekDays.includes(date); return <div key={date} className={checked ? 'done' : ''} aria-current={date === meta.today ? 'date' : undefined}><small>周{'一二三四五六日'[i]}</small><span aria-label={`${date}${checked ? '已打卡' : '未打卡'}`}>{checked ? '✓' : dayjs(date).date()}</span></div>; })}</div>
      </div>}</Load>
    </Card>
    <Segmented block aria-label="运动打卡栏目" value={tab} onChange={setTab} options={[{ value: 'today', label: '今日打卡' }, { value: 'mine', label: '我的记录' }, { value: 'public', label: '同行动态' }]} />
    <Load query={query}>{meta => <>{tab === 'today' ? <CheckIn meta={meta} refresh={refresh} /> : <Records key={tab} user={user} meta={meta} scope={tab} revision={revision} refresh={refresh} />}
      {editing && <Settings meta={meta} close={() => setEditing(false)} saved={() => { setEditing(false); refresh(); }} />}</>}</Load>
  </div>;
}
function CheckIn({ meta, refresh }) {
  const [form] = Form.useForm(), { run, busy, confirm } = useAction();
  const { message } = App.useApp();
  const [files, setFiles] = useState([]), [reward, setReward] = useState(null);
  const category = Form.useWatch('category', form) || 'cardio', sport = Form.useWatch('sport', form);
  const minutes = Form.useWatch('minutes', form);
  const pending = useRef(null);
  const selected = meta.catalog.find(c => c.id === category);
  const custom = meta.customSports.filter(s => s.category === category && !selected.sports.includes(s.name));
  async function submit(values) {
    await run(async () => {
      const name = values.sport === '__custom' ? values.customSport?.trim() : values.sport;
      if (!await confirm('确认记录这次运动？', `${iso(values.date)} · ${name} · ${values.minutes} 分钟。${values.visibility === 'private' ? '仅自己可见。' : '将展示在同行动态中。'}`, false, '确认打卡')) return null;
      const images = await Promise.all(files.map(file => encodeImage(file.originFileObj || file)));
      const body = { category: values.category, sportName: name, date: iso(values.date), minutes: values.minutes, note: values.note || '', visibility: values.visibility, images };
      const signature = JSON.stringify(body);
      if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
      return API.exerciseCreate({ ...body, requestKey: pending.current.key });
    }, null, data => {
      if (!data) return;
      message.success('运动已记录');
      setReward(data.reward); setFiles([]); form.setFieldsValue({ note: '' }); pending.current = null; refresh();
    });
  }
  return <Card><div className="stack"><div className="row-between"><Heading>{meta.todayCount ? '再记录一次运动' : '今天，也为自己动一动'}</Heading>{!!meta.todayCount && <Tag color="green">今日已打卡 {meta.todayCount} 次</Tag>}</div>
    {reward && <RewardReceipt reward={reward} />}
    <Form form={form} layout="vertical" initialValues={{ category: 'cardio', sport: '快走', date: dayjs(meta.today), minutes: 30, visibility: 'public' }} onFinish={submit} disabled={busy}>
      <div className="exercise-form-grid"><Form.Item label="运动分类" name="category" rules={[{ required: true }]}><Select options={meta.catalog.map(c => ({ value: c.id, label: c.name }))} onChange={id => form.setFieldsValue({ sport: meta.catalog.find(c => c.id === id).sports[0], customSport: '' })} /></Form.Item>
        <Form.Item label="运动项目" name="sport" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={[...selected.sports.map(name => ({ value: name, label: name })), ...custom.map(s => ({ value: s.name, label: `${s.name} · 我的项目` })), { value: '__custom', label: '＋ 自定义运动项目' }]} /></Form.Item>
      </div>
      {sport === '__custom' && <Form.Item label="自定义项目名称" name="customSport" rules={[{ required: true, whitespace: true, message: '请填写运动项目名称' }]} extra="仅为你的账号保留，打卡后可再次选用。"><Input placeholder="例如：壶铃训练" maxLength={30} showCount /></Form.Item>}
      <div className="exercise-form-grid"><Form.Item label="运动日期" name="date" rules={[{ required: true }]} extra="可补记最近 7 天，补记不奖励禾穗。"><DatePicker allowClear={false} inputReadOnly disabledDate={d => iso(d) < meta.earliestDate || iso(d) > meta.today} style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="运动时长（分钟）" name="minutes" rules={[{ required: true, message: '请填写时长' }]}><InputNumber min={1} max={1440} precision={0} style={{ width: '100%' }} /></Form.Item></div>
      <div className="exercise-minute-presets"><span className="muted">快速选择</span>{[10, 20, 30, 45, 60].map(n => <Button key={n} size="small" type={minutes === n ? 'primary' : 'default'} onClick={() => form.setFieldValue('minutes', n)}>{n} 分钟</Button>)}</div>
      <Form.Item label="运动感受（选填）" name="note"><Input.TextArea maxLength={300} showCount rows={2} placeholder="记录今天的小进步…" /></Form.Item>
      <Form.Item label="运动照片（选填，最多 3 张）"><Upload listType="picture-card" accept="image/jpeg,image/png,image/webp" maxCount={3} fileList={files} onChange={({ fileList }) => setFiles(fileList.slice(0, 3))} beforeUpload={() => false}>{files.length < 3 && <span><PlusOutlined /><br />添加照片</span>}</Upload></Form.Item>
      <Form.Item name="visibility" label="谁可以看到"><Radio.Group options={[{ label: '公开，与大家同行', value: 'public' }, { label: '🔒 仅自己可见', value: 'private' }]} /></Form.Item>
      <div className="exercise-submit"><small className="muted">🌾 每天首次打卡 +2 禾穗，多次运动只奖励一次。</small><Button type="primary" htmlType="submit" loading={busy}>完成运动，打卡</Button></div>
    </Form>
  </div></Card>;
}
function Settings({ meta, close, saved }) {
  const { run, busy } = useAction();
  return <Modal open title="运动目标与提醒" footer={null} onCancel={() => !busy && close()}><Form layout="vertical" initialValues={{ ...meta.settings, reminderTime: dayjs(`2000-01-01T${meta.settings.reminderTime}`) }} onFinish={values => run(() => API.exerciseSettings({ ...values, reminderTime: values.reminderTime.format('HH:mm') }), '设置已保存', saved)}>
    <Form.Item label="每周运动几天" name="weeklyGoal" rules={[{ required: true }]}><InputNumber min={1} max={7} precision={0} addonAfter="天" /></Form.Item>
    <Form.Item label="每天提醒我运动" name="reminderEnabled" valuePropName="checked"><Switch /></Form.Item><Form.Item label="提醒时间（北京时间）" name="reminderTime" rules={[{ required: true }]}><TimePicker format="HH:mm" allowClear={false} inputReadOnly /></Form.Item>
    <p className="muted">当天已打卡就不再提醒。站内消息会保留；关闭页面后的通知还需在「名字 → 消息提醒」开启本机推送及运动打卡提醒。</p><div className="exercise-submit"><Button disabled={busy} onClick={close}>取消</Button><Button type="primary" htmlType="submit" loading={busy}>保存设置</Button></div>
  </Form></Modal>;
}
function Records({ user, meta, scope, revision, refresh }) {
  const [month, setMonth] = useState(monthOf(meta.today)), [date, setDate] = useState(null), [page, setPage] = useState(1), [privateOnly, setPrivateOnly] = useState(false), [view, setView] = useState('calendar');
  const query = usePageLoad(`exercise-${scope}-${month}-${date}-${page}-${privateOnly}-${revision}`, () => API.exerciseRecords({ scope, month, page, ...(date && view === 'calendar' ? { date } : {}), visibility: privateOnly ? 'private' : 'all' }));
  const ranks = usePageLoad(scope === 'public' ? `exercise-ranks-${revision}` : null, API.exerciseRanking);
  function changeMonth(value) { setMonth(value); setDate(null); setPage(1); }
  return <div className="stack">{scope === 'public' && <Card><Heading>🏅 本周同行榜</Heading><p className="muted">按本周公开打卡天数排列，一天多次只计一天。</p><Load query={ranks}>{data => <>{data.items.length ? <div className="exercise-podium">{data.items.map((p, i) => <div key={p.id} className={`exercise-rank rank-${i + 1}`}><span>{['🥇', '🥈', '🥉'][i]}</span><strong>{personName(p, user.id)}</strong><small>{p.days} 天</small></div>)}</div> : <Blank>来成为本周第一位同行者吧</Blank>}<p className="muted">{data.me ? `我的排名：第 ${data.me.rank} 名 · ${data.me.days} 天` : '公开打卡后即可参与本周排行，私密记录不会计入。'}</p></>}</Load></Card>}
    <Card>{scope === 'mine' && <><div className="row-between"><Segmented aria-label="运动记录视图" value={view} onChange={v => { setView(v); setDate(null); setPage(1); }} options={[{ value: 'calendar', label: '日历' }, { value: 'list', label: '列表' }]} /><Checkbox checked={privateOnly} onChange={e => { setPrivateOnly(e.target.checked); setPage(1); }}>仅自己可见</Checkbox></div>
      {view === 'list' && <DatePicker picker="month" allowClear={false} inputReadOnly value={dayjs(month + '-01')} onChange={d => changeMonth(d.format('YYYY-MM'))} style={{ marginTop: 16 }} />}
    </>}
      <Load query={query}>{data => <div className="stack">{scope === 'mine' && view === 'calendar' && <MonthCalendar month={month} startDate={meta.firstDate} endDate={meta.today} move={changeMonth} selected={date} pick={d => { setDate(d === date ? null : d); setPage(1); }} blocked={d => iso(d) > meta.today} dayInfo={d => { const info = data.days.find(i => i.date === d); return info ? { label: `运动 ${info.count} 次，共 ${info.minutes} 分钟`, badge: <small>{info.count} 次</small>, className: 'exercise-calendar-done' } : null; }} />}
        {scope === 'mine' && <div className="row-between"><strong>{date ? dateText(date) : `${month} 的运动记录`}</strong>{date && <Button size="small" type="link" onClick={() => { setDate(null); setPage(1); }}>查看整月</Button>}</div>}
        {!data.items.length ? <Blank>{scope === 'public' ? '还没有同行动态，先记录一次运动吧' : '还没有运动记录，慢慢开始就很好'}</Blank> : data.items.map(record => <Record key={record.id} record={record} user={user} refresh={() => { query.refresh(); refresh(); }} />)}
        {data.total > data.pageSize && <Pagination size="small" current={page} pageSize={data.pageSize} total={data.total} showSizeChanger={false} onChange={setPage} />}
      </div>}</Load>
    </Card>
  </div>;
}
function Record({ record, user, refresh }) {
  const { run, busy, confirm } = useAction();
  const [showImages, setShowImages] = useState(false);
  const photos = useLoad(showImages ? record.id : null, () => API.exerciseImages(record.id));
  const mine = record.userId === user.id;
  return <article className={`exercise-record ${record.visibility === 'private' ? 'exercise-private' : ''}`}><div className="row-between"><strong>{record.sportName} <small>{record.minutes} 分钟</small></strong>{record.visibility === 'private' && <Tag color="purple">🔒 仅自己可见</Tag>}</div>
    <small className="muted">{personName(record, user.id)} · {dateText(record.date)}</small>{record.note && <p className="exercise-note">{record.note}</p>}
    {!!record.imageCount && (showImages ? <Load query={photos}>{items => <Image.PreviewGroup><div className="exercise-photos">{items.map(i => <Image key={i.position} src={i.src} width={80} height={80} style={{ objectFit: 'cover' }} alt={`${record.sportName}的运动照片 ${i.position}`} />)}</div></Image.PreviewGroup>}</Load> : <Button type="link" size="small" onClick={() => setShowImages(true)}>查看 {record.imageCount} 张照片</Button>)}
    <div className="row-between"><small className="muted">{timeText(record.createdAt)} 记录</small><Space>{record.visibility === 'public' && <Button type="text" size="small" disabled={busy || mine} icon={record.liked ? <HeartFilled /> : <HeartOutlined />} onClick={() => run(() => API.exerciseLike(record.id, !record.liked), null, refresh)}>点赞 {record.likeCount}</Button>}{mine && <Button type="text" size="small" disabled={busy} onClick={async () => { if (await confirm('删除这条运动记录？', '将从运动记录与同行动态中移除，已领取的当日奖励不会重复发放。', true, '删除')) run(() => API.exerciseRemove(record.id), '已删除', refresh); }}>删除</Button>}</Space></div>
  </article>;
}
