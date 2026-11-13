import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import Dropdown from 'antd/es/dropdown';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Segmented from 'antd/es/segmented';
import Select from 'antd/es/select';
import Tabs from 'antd/es/tabs';
import Tag from 'antd/es/tag';
import AimOutlined from '@ant-design/icons/es/icons/AimOutlined';
import { API, Blank, Field, Heading, Load, dateText, dayjs, isAdmin, iso, monthOf, option, personLabel, required, today, useAction, usePageLoad, weekdays } from './shared';
import { MonthCalendar } from './MonthCalendar';

const dateTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
const timeText = value => dateTime.format(new Date(value));
const ranges = [7, 30, 90].map(days => option(days, `近 ${days} 天`));
const weekdayOptions = [1, 2, 3, 4, 5, 6, 0].map(day => option(day, weekdays[day]));
const rate = (attended, expected) => expected ? `${Math.round(attended * 1000 / expected) / 10}%` : '—';
const statusLabels = { present: ['green', '已签到'], absent: ['red', '未出勤'], pending: ['default', '未签到'] };
const isAttendanceActive = (event, now) => Date.parse(event.startsAt) <= now && now < Date.parse(event.endsAt);

function useAttendanceClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function WorkbenchAttendance({ user, open }) {
  const events = usePageLoad(user.id, API.attendanceEvents, true);
  const now = useAttendanceClock();
  return <Card size="small">
    <div className="attendance-entry">
      <Heading>签到登记</Heading>
      <Button className="card-more-link" type="link" onClick={open}>更多签到活动 ›</Button>
    </div>
    <Load query={events}>{items => {
      const active = items.filter(event => event.isMember === 1 && isAttendanceActive(event, now))
        .sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
      return active.length ? <ul className="attendance-rows">{active.map(event => (
        <li key={event.id} className="row-between">
          <div><strong>{event.title}</strong><div className="muted">签到截止 {timeText(event.endsAt)}</div></div>
          <AttendanceCheckIn event={event} refresh={events.refresh} />
        </li>
      ))}</ul> : <p className="muted">暂无正在签到的活动</p>;
    }}</Load>
  </Card>;
}

export default function Attendance({ user, back }) {
  const admin = isAdmin(user);
  const [tab, setTab] = useState('events');
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);
  const header = useRef(null);
  const [stickyTop, setStickyTop] = useState(0);
  const now = useAttendanceClock();
  const events = usePageLoad(tab === 'events' ? user.id : null, API.attendanceEvents, true);
  const people = usePageLoad(admin && (creating || tab === 'people') ? 'attendance-people' : null, API.adminUsers, true);
  useLayoutEffect(() => {
    const workspaceTop = header.current.closest('.workspace').querySelector('.workspace-top');
    const measure = () => setStickyTop(workspaceTop.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspaceTop);
    return () => observer.disconnect();
  }, []);
  return <>
    <div ref={header} className="attendance-list-header" style={{ top: stickyTop }}>
      <Card>
        {back && <Button type="link" className="period-back" onClick={back}>← 返回工作台</Button>}
        <div className="row-between"><Heading>签到登记</Heading>
          {admin && tab === 'events' && <Button type="primary" onClick={() => setCreating(true)}>新建签到</Button>}
        </div>
        <Tabs activeKey={tab} onChange={setTab} items={[
          { key: 'events', label: '签到活动' },
          { key: 'people', label: admin ? '人员出勤' : '我的出勤' },
        ]} />
      </Card>
    </div>
    {tab === 'events' ? <Load query={events}>{items => (
      <AttendanceViews events={items} referenceDate={timeText(now).slice(0, 10)} defaultView="list"
        label="签到活动视图" empty="暂无签到活动" now={now}>
        {visible => visible.map(event => <AttendanceCard key={event.id} event={event} now={now} admin={admin}
          canCheckIn={user.role !== 'super_admin'} open={() => setDetail(event.id)} refresh={events.refresh} />)}
      </AttendanceViews>
    )}</Load> : <PersonAttendance user={user} people={people} />}
    {creating && <Modal title="新建签到" open footer={null} onCancel={() => setCreating(false)}>
      <Load query={people}>{users => <CreateAttendance currentUserId={user.id}
        users={users.filter(member => member.status === 'active' && member.role !== 'super_admin')}
        saved={() => { setCreating(false); events.refresh(); }} />}</Load>
    </Modal>}
    {detail !== null && <EventDetail id={detail} currentUserId={user.id} now={now} close={() => setDetail(null)} onUpdate={events.refresh} />}
  </>;
}

function AttendanceViews({ events, referenceDate, range, dateField = 'startsAt', defaultView = 'calendar', label, empty, showAttendanceCounts,
  highlightEvents, highlightOwn, now, children }) {
  const [view, setView] = useState(defaultView);
  const [month, setMonth] = useState(() => monthOf(referenceDate));
  const [date, setDate] = useState(null);
  const list = useRef(null);
  const pendingJump = useRef(false);
  const [activeCardVisible, setActiveCardVisible] = useState(false);
  const hasActiveEvents = now != null && events.some(event => isAttendanceActive(event, now));

  useLayoutEffect(() => {
    if (view !== 'list' || !hasActiveEvents || !list.current) return;
    const eventList = list.current;
    const workspace = eventList.closest('.workspace');
    const header = workspace.querySelector('.attendance-list-header');
    const footer = workspace.querySelector('.bottom-nav');
    let frame = 0;
    function measure() {
      frame = 0;
      const top = header.getBoundingClientRect().bottom;
      const bottom = footer.getBoundingClientRect().top;
      const visible = [...eventList.querySelectorAll('.attendance-card-active')].some(card => {
        const rect = card.getBoundingClientRect();
        return Math.min(rect.bottom, bottom) - Math.max(rect.top, top) >= Math.min(48, rect.height);
      });
      setActiveCardVisible(visible);
    }
    function scheduleMeasure() {
      if (!frame) frame = window.requestAnimationFrame(measure);
    }
    measure();
    window.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    const observer = new ResizeObserver(scheduleMeasure);
    for (const element of [eventList, header, footer]) observer.observe(element);
    return () => {
      window.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [view, hasActiveEvents, events, now]);

  function scrollToActiveEvent() {
    const card = list.current?.querySelector('.attendance-card-active');
    if (!card) return;
    const workspace = card.closest('.workspace');
    const header = workspace.querySelector('.workspace-top').getBoundingClientRect().height;
    const controls = workspace.querySelector('.attendance-list-header').getBoundingClientRect().height;
    card.focus({ preventScroll: true });
    window.scrollTo(0, window.scrollY + card.getBoundingClientRect().top - header - controls - 12);
  }

  useLayoutEffect(() => {
    if (view === 'list' && pendingJump.current) {
      pendingJump.current = false;
      scrollToActiveEvent();
    }
  }, [view]);

  function jumpToActiveEvent() {
    if (view === 'list') scrollToActiveEvent();
    else {
      pendingJump.current = true;
      setView('list');
    }
  }
  const byDate = new Map();
  for (const event of events) {
    const eventDate = timeText(event[dateField]).slice(0, 10);
    if (!byDate.has(eventDate)) byDate.set(eventDate, []);
    byDate.get(eventDate).push(event);
  }
  const dates = [...byDate.keys(), referenceDate].sort();
  const startDate = range?.startDate ?? dates[0];
  const endDate = range?.endDate ?? dates.at(-1);
  const firstMonth = monthOf(startDate);
  const lastMonth = monthOf(endDate);
  const visibleMonth = month < firstMonth ? firstMonth : month > lastMonth ? lastMonth : month;
  const selectedEvents = byDate.get(date) ?? [];
  return <>
    <Card>
      <div className="stack">
        <Segmented block aria-label={label} value={view} onChange={setView}
          options={[option('calendar', '日历'), option('list', '列表')]} />
        {view === 'calendar' && showAttendanceCounts && <div className="inline muted">
          <span>实到 / 应到人次</span>
          {highlightEvents && <>
            <Tag color="green">{highlightOwn ? '我已出勤' : '已出勤'}</Tag>
            <Tag color="red">{highlightOwn ? '我有未出勤' : '应到未到'}</Tag>
          </>}
        </div>}
        {view === 'calendar' && <MonthCalendar month={visibleMonth} startDate={startDate} endDate={endDate}
          move={setMonth} selected={date} pick={setDate}
          blocked={day => !!range && (iso(day) < startDate || iso(day) > endDate)}
          dayInfo={day => {
            const items = byDate.get(day) ?? [];
            const highlighted = highlightEvents ? items.filter(highlightEvents) : [];
            const missed = highlighted.filter(event => !event.checkedInAt).length;
            const highlight = missed ? 'attendance-day-absent' : highlighted.length ? 'attendance-day-present' : undefined;
            const status = highlighted.length
              ? `，${highlightOwn ? '我' : '所选人员'}出勤 ${highlighted.length - missed} 场，未出勤 ${missed} 场` : '';
            if (showAttendanceCounts && items.length && items.every(event => Number.isInteger(event.expected) && Number.isInteger(event.attended))) {
              const attended = items.reduce((total, event) => total + event.attended, 0);
              const expected = items.reduce((total, event) => total + event.expected, 0);
              return {
                label: `实到 ${attended} / 应到 ${expected} 人次${status}`,
                badge: <small className="calendar-count">{attended}/{expected}</small>,
                className: highlight,
              };
            }
            const count = items.length;
            return { label: `${count} 场活动${status}`, badge: count > 0 && <small className="calendar-count">{count} 场</small>, className: highlight };
          }} />}
      </div>
    </Card>
    {view === 'list' && (events.length ? <div className="stack" ref={list}>{children(events)}</div> : <Blank>{empty}</Blank>)}
    {hasActiveEvents && !date && (view === 'calendar' || !activeCardVisible) &&
      <Button className="attendance-jump" type="primary" shape="round" icon={<AimOutlined />}
        aria-label="定位到正在签到的活动" onClick={jumpToActiveEvent}>签到中</Button>}
    {date && <Modal open title={`${dateText(date)} · 签到活动`} onCancel={() => setDate(null)}
      footer={<Button onClick={() => setDate(null)}>关闭</Button>}>
      <div className="stack">{selectedEvents.length ? children(selectedEvents) : <Blank>当天没有签到活动</Blank>}</div>
    </Modal>}
  </>;
}

function AttendanceCard({ event, now, admin, canCheckIn, open, refresh }) {
  const { checkedInAt, busy, checkIn } = useAttendanceCheckIn(event, refresh);
  const started = now >= Date.parse(event.startsAt);
  const ended = now >= Date.parse(event.endsAt);
  const active = isAttendanceActive(event, now);
  const isMember = canCheckIn && event.isMember === 1;
  const showCheckIn = isMember && !checkedInAt && !ended;
  return <Card className={active ? 'attendance-card attendance-card-active' : 'attendance-card'}
    tabIndex={active ? -1 : undefined} title={<div className="attendance-card-title">
    <span>{event.title}</span>
    {isMember && checkedInAt && <CheckedInTag time={checkedInAt} />}
    {isMember && ended && !checkedInAt && <Tag color="red">未出勤</Tag>}
  </div>}
    extra={<Tag color={active ? 'blue' : 'default'}>{ended ? '已结束' : active ? '签到中' : '未开始'}</Tag>}>
    <div className="attendance-card-body">
      <div className="attendance-card-info">
        <div className="muted">签到时间 {timeText(event.startsAt)} 至 {timeText(event.endsAt)}</div>
        {admin && <div>{ended ? `出勤率 ${rate(event.attended, event.expected)} · ` : ''}已签到 {event.attended} / 应到 {event.expected} 人</div>}
      </div>
      {(showCheckIn || admin) && <div className="inline attendance-card-actions">
        {showCheckIn && <Button type="primary" disabled={!started} loading={busy} onClick={checkIn}>签到</Button>}
        {admin && <Button onClick={open}>查看出勤明细</Button>}
      </div>}
    </div>
  </Card>;
}

function useAttendanceCheckIn(event, refresh) {
  const { run, busy, confirm } = useAction();
  const [savedAt, setSavedAt] = useState(null);
  const checkedInAt = event.checkedInAt || savedAt;
  async function checkIn() {
    const content = <p className="attendance-title">请确认你已到达「{event.title}」活动现场。签到提交后无法修改。</p>;
    if (!await confirm('确认已到场？', content, false, '确认签到')) return;
    await run(() => API.checkIn(event.id), '签到成功', result => setSavedAt(result.checkedInAt));
    refresh();
  }
  return { checkedInAt, busy, checkIn };
}

function CheckedInTag({ time }) {
  return <Tag color="green">已签到 {timeText(time)}</Tag>;
}

function AttendanceCheckIn({ event, refresh }) {
  const { checkedInAt, busy, checkIn } = useAttendanceCheckIn(event, refresh);
  return checkedInAt ? <CheckedInTag time={checkedInAt} />
    : <Button type="primary" loading={busy} onClick={checkIn}>签到</Button>;
}

function CreateAttendance({ users, currentUserId, saved }) {
  const [form] = Form.useForm();
  const [mode, setMode] = useState('single');
  const { run, busy } = useAction();
  const [initial] = useState(() => {
    const startDate = today();
    const startTime = '00:00';
    const endTime = '23:59';
    return {
      startsAt: `${startDate}T${startTime}`,
      endsAt: `${startDate}T${endTime}`,
      repeat: { startDate, endDate: iso(dayjs(startDate).add(28, 'day')), weekdays: [0], startTime, endTime },
    };
  });
  const batch = mode === 'weekly';
  function submit(values) {
    const { title, memberIds } = values;
    const timing = batch ? { repeat: values.repeat } : {
      startsAt: new Date(`${values.startsAt}+08:00`).toISOString(),
      endsAt: new Date(`${values.endsAt}+08:00`).toISOString(),
    };
    return run(() => API.createAttendance({ title, memberIds, ...timing }),
      result => batch ? `已发布 ${result.count} 场签到活动` : '签到已创建', saved);
  }
  return <Form form={form} layout="vertical" initialValues={initial} disabled={busy} onFinish={submit}>
    <Form.Item label="发布方式">
      <Segmented block value={mode} onChange={setMode} options={[option('single', '单次发布'), option('weekly', '按星期批量发布')]} />
    </Form.Item>
    <Form.Item label="活动名称" name="title" rules={required}><Input maxLength={80} placeholder="如周日聚会、团队培训" /></Form.Item>
    {batch ? <>
      <div className="form-grid">
        <Form.Item label="起始日期" name={['repeat', 'startDate']} rules={required}><Input type="date" /></Form.Item>
        <Form.Item label="截止日期" name={['repeat', 'endDate']} rules={required}><Input type="date" /></Form.Item>
      </div>
      <Form.Item label="每周签到日" name={['repeat', 'weekdays']} rules={[{ required: true, type: 'array', min: 1, message: '请至少选择一个星期' }]}>
        <Checkbox.Group aria-label="每周签到日" options={weekdayOptions} />
      </Form.Item>
      <div className="form-grid">
        <Form.Item label="每日开始时间" name={['repeat', 'startTime']} rules={required}><Input type="time" /></Form.Item>
        <Form.Item label="每日结束时间" name={['repeat', 'endTime']} rules={required}><Input type="time" /></Form.Item>
      </div>
      <p className="muted attendance-batch-note">按北京时间发布，已结束的日期会跳过。</p>
    </> : <>
      <Form.Item label="签到开始时间（北京时间）" name="startsAt" rules={required}><Input type="datetime-local" /></Form.Item>
      <Form.Item label="签到结束时间（北京时间）" name="endsAt" rules={required}><Input type="datetime-local" /></Form.Item>
    </>}
    <Form.Item label="应到人员" name="memberIds" rules={[{ required: true, type: 'array', min: 1, message: '请选择应到人员' }]}>
      <Select mode="multiple" showSearch optionFilterProp="label" maxTagCount="responsive" maxCount={500}
        options={users.map(member => option(member.id, personLabel({ ...member, name: member.displayName || member.name }, currentUserId)))} />
    </Form.Item>
    <div className="row-between">
      {users.length > 0 && users.length <= 500 && <Button type="link" onClick={() => form.setFieldValue('memberIds', users.map(member => member.id))}>全选人员</Button>}
      <Button type="primary" htmlType="submit" loading={busy}>{batch ? '批量发布' : '创建签到'}</Button>
    </div>
  </Form>;
}

function EventDetail({ id, currentUserId, now, close, onUpdate }) {
  const query = usePageLoad(id, () => API.attendanceEvent(id), true);
  const [mode, setMode] = useState('view');
  const title = { view: '出勤明细', edit: '编辑应到名单', proxy: '批量代签到' }[mode];
  function refresh() {
    query.refresh();
    onUpdate();
  }
  function saved() {
    setMode('view');
    refresh();
  }
  return <Modal title={title} open onCancel={close}
    footer={mode === 'view' ? <Button onClick={close}>关闭</Button> : null}>
    <Load query={query}>{event => mode === 'edit'
      ? <EditEventMembers event={event} currentUserId={currentUserId} loading={query.loading} cancel={() => setMode('view')}
        saved={saved} failed={query.refresh} />
      : <EventMembers key={mode} event={event} currentUserId={currentUserId} now={now} loading={query.loading}
        selecting={mode === 'proxy'} setMode={setMode} saved={saved} />}</Load>
  </Modal>;
}

function EditEventMembers({ event, currentUserId, loading, cancel, saved, failed }) {
  const people = usePageLoad('attendance-roster-users', API.adminUsers);
  const [add, setAdd] = useState([]);
  const [remove, setRemove] = useState([]);
  const { run, busy, confirm } = useAction();
  const currentIds = new Set(event.members.map(member => member.userId));
  const removableMembers = event.members.filter(member => !member.checkedInAt);
  const removableIds = new Set(removableMembers.map(member => member.userId));
  const checkedInCount = event.members.length - removableMembers.length;
  const changes = { add: add.filter(id => !currentIds.has(id)), remove: remove.filter(id => removableIds.has(id)) };
  const total = event.members.length + changes.add.length - changes.remove.length;
  const disabled = busy || loading;
  async function save() {
    if (changes.remove.length && !await confirm('确认调整应到名单？',
      `将新增 ${changes.add.length} 人、移除 ${changes.remove.length} 人。保存后会重新统计出勤率。`, false, '保存名单')) return;
    const ok = await run(() => API.updateAttendanceMembers(event.id, changes), '应到名单已更新', saved);
    if (!ok) failed();
  }
  return <div className="stack">
    <strong className="attendance-title">{event.title}</strong>
    <Load query={people}>{users => <div className="stack">
      <span>新增应到人员</span>
      <Select aria-label="新增应到人员" mode="multiple" showSearch optionFilterProp="label" value={changes.add} onChange={setAdd}
        disabled={disabled} maxTagCount="responsive" placeholder="选择要加入名单的人员"
        options={users.filter(user => user.status === 'active' && user.role !== 'super_admin' && !currentIds.has(user.id))
          .map(user => option(user.id, personLabel({ ...user, name: user.displayName || user.name }, currentUserId)))} />
    </div>}</Load>
    <div>
      <strong>未签到人员</strong>
      {checkedInCount > 0 && <p className="muted">已签到 {checkedInCount} 人，签到记录会保留。</p>}
      {removableMembers.length > 0 ? <>
        <p className="muted">勾选要移除的人员。</p>
        <ul className="attendance-rows attendance-scroll-list attendance-roster" aria-label="未签到人员" tabIndex={0}>
          {removableMembers.map(member => {
            const marked = changes.remove.includes(member.userId);
            return <li key={member.userId} className={marked ? 'row-between attendance-roster-remove' : 'row-between'}>
              <Checkbox checked={marked} disabled={disabled}
                onChange={change => setRemove(ids => change.target.checked
                  ? [...ids, member.userId] : ids.filter(id => id !== member.userId))}>{personLabel(member, currentUserId)}</Checkbox>
              {marked ? <Tag color="red">待移除</Tag> : <AttendanceStatus status={member.status} />}
            </li>;
          })}
        </ul>
      </> : <p className="muted">没有可移除的人员。</p>}
    </div>
    <p className="muted">{total < 1 || total > 500 ? '应到人员须为 1 至 500 人' : `保存后应到 ${total} 人`}</p>
    <div className="row-between">
      <Button onClick={cancel} disabled={busy}>取消</Button>
      <Button type="primary" loading={busy}
        disabled={disabled || total < 1 || total > 500 || !(changes.add.length || changes.remove.length)} onClick={save}>保存名单</Button>
    </div>
  </div>;
}

function EventMembers({ event, currentUserId, now, loading, selecting, setMode, saved }) {
  const [selected, setSelected] = useState([]);
  const { run, busy, confirm } = useAction();
  const started = now >= Date.parse(event.startsAt);
  const ended = now >= Date.parse(event.endsAt);
  const members = [...event.members].sort((a, b) => Number(!!b.checkedInAt) - Number(!!a.checkedInAt));
  const pendingIds = event.members.filter(member => !member.checkedInAt).map(member => member.userId);
  const canProxy = started && pendingIds.length > 0;
  const memberIds = selected.filter(id => pendingIds.includes(id));
  const allSelected = pendingIds.length > 0 && pendingIds.length === memberIds.length;
  const disabled = busy || loading;
  async function proxyCheckIn() {
    const description = <p className="attendance-title">请确认「{event.title}」中选中的 {memberIds.length} 人均已到场。代签到会计入出勤。</p>;
    if (!await confirm('确认批量代签到？', description, false, '确认代签到')) return;
    await run(() => API.proxyCheckIn(event.id, memberIds),
      result => result.checkedIn ? `已为 ${result.checkedIn} 人代签到` : '所选人员均已签到', saved);
  }
  return <div className="stack">
    <div className="row-between">
      <strong className="attendance-title">{event.title}</strong>
      {!selecting && <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: [
        { key: 'edit', label: '编辑应到名单' },
        ...(canProxy ? [{ key: 'proxy', label: '批量代签到' }] : []),
      ], onClick: ({ key }) => setMode(key) }}>
        <Button size="small" disabled={disabled}>操作 ▾</Button>
      </Dropdown>}
    </div>
    {selecting && canProxy && <div className="row-between">
      <Checkbox checked={allSelected} indeterminate={memberIds.length > 0 && !allSelected} disabled={disabled}
        onChange={change => setSelected(change.target.checked ? pendingIds : [])}>全选未签到</Checkbox>
    </div>}
    <ul className="attendance-rows attendance-scroll-list" aria-label="应到人员名单" tabIndex={0}>{members.map(member => (
      <li key={member.userId} className="attendance-detail-row">
        {selecting && canProxy && !member.checkedInAt
          ? <Checkbox checked={memberIds.includes(member.userId)} disabled={disabled}
            onChange={change => setSelected(ids => change.target.checked
              ? [...ids, member.userId] : ids.filter(id => id !== member.userId))}>{personLabel(member, currentUserId)}</Checkbox>
          : <span>{personLabel(member, currentUserId)}</span>}
        <span className="attendance-detail-meta">
          <span className="inline attendance-detail-status">
            <AttendanceStatus status={member.checkedInAt ? 'present' : ended ? 'absent' : member.status} />
            {member.checkedInAt && <small className="muted">{timeText(member.checkedInAt)}</small>}
          </span>
          {member.checkedInByName && <small className="muted">代签人 {member.checkedInByName}</small>}
        </span>
      </li>
    ))}</ul>
    {selecting && <div className="row-between">
      <Button disabled={busy} onClick={() => setMode('view')}>取消</Button>
      <Button type="primary" disabled={disabled || !memberIds.length} loading={busy} onClick={proxyCheckIn}>
        确认代签到{memberIds.length > 0 && `（${memberIds.length}）`}
      </Button>
    </div>}
  </div>;
}

function AttendanceStatus({ status }) {
  const [color, label] = statusLabels[status];
  return <Tag color={color}>{label}</Tag>;
}

function PersonAttendance({ user, people }) {
  const [selected, setSelected] = useState(user.role === 'super_admin' ? undefined : user.id);
  const [days, setDays] = useState(30);
  const allPeople = selected === 'all';
  const highlightEvents = event => !allPeople || event.isMember === 1;
  const query = usePageLoad(selected == null ? null : `${selected}:${days}`, () => API.personAttendance(selected, days));
  return <>
    <Card>
      {isAdmin(user) && <Load query={people}>{users => <Field label="人员">
        <Select aria-label="人员" placeholder="选择人员" showSearch optionFilterProp="label" value={selected} onChange={setSelected}
          options={[option('all', '全部人员'), ...users.map(member => option(member.id, personLabel({ ...member, name: member.displayName || member.name }, user.id)))]} />
      </Field>}</Load>}
      <Field label="统计范围"><Select aria-label="统计范围" value={days} onChange={setDays} options={ranges} /></Field>
      <p className="muted">统计范围包含今天，只计算已结束的活动。</p>
    </Card>
    {selected != null && <Load query={query}>{result => <>
      <Card title={allPeople ? '团队出勤率' : '近期出勤率'} extra={<strong>{rate(result.attended, result.expected)}</strong>}>
        <div className="muted">{result.startDate} 至 {result.endDate} · 出勤 {result.attended} / 应到 {result.expected} {allPeople ? '人次' : '次'}</div>
      </Card>
      <AttendanceViews events={result.events} referenceDate={result.endDate} range={result} dateField="endsAt"
        showAttendanceCounts highlightEvents={highlightEvents} highlightOwn={allPeople || selected === user.id}
        label="人员出勤视图" empty="这段时间暂无出勤记录">
        {visible => <Card size="small"><ul className="attendance-rows">{visible.map(event => (
          <li key={event.id} className="row-between">
            <div>
              <strong>{event.title}</strong><div className="muted">{timeText(event.endsAt)}</div>
              {Number.isInteger(event.expected) && <div className="muted">实到 {event.attended} / 应到 {event.expected} 人</div>}
            </div>
            {highlightEvents(event) && <AttendanceStatus status={event.checkedInAt ? 'present' : 'absent'} />}
          </li>
        ))}</ul></Card>}
      </AttendanceViews>
    </>}</Load>}
  </>;
}
