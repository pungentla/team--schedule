import React, { useEffect, useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import Collapse from 'antd/es/collapse';
import DatePicker from 'antd/es/date-picker';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import InputNumber from 'antd/es/input-number';
import Modal from 'antd/es/modal';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Statistic from 'antd/es/statistic';
import Steps from 'antd/es/steps';
import Tag from 'antd/es/tag';
import { API, Blank, Field, Heading, Load, assignmentLabel, dateText, dayjs, iso, monthOf, option, periodLabels, required, shiftText, swapLabels, timeText, today, useAction, useLoad, usePageLoad } from './shared';
import { usePullRefresh } from './PullToRefresh';
import { ScheduleDetails } from './Schedule';
import { Adjustments } from './Adjustments';
import { ProxyEnrollment } from './Enrollment';
import { MonthCalendar } from './MonthCalendar';

const transitions = { draft: ['enrolling', 'archived'], enrolling: ['scheduling', 'draft', 'archived'], scheduling: ['enrolling', 'archived'], published: ['archived'], archived: [] };
const durations = [option('custom', '自定义起止日期'), option('week', '一周'), option('month', '一个月'), option('bimonth', '双月'), option('quarter', '一个季度'), option('halfyear', '半年'), option('year', '一年')];

const statusColors = { draft: 'default', enrolling: 'blue', scheduling: 'gold', published: 'green', archived: 'default' };

function PeriodBadge({ period, hasDraft = period.hasDraft }) {
  const status = hasDraft && ['draft', 'enrolling'].includes(period.status) ? 'scheduling' : period.status;
  return <Tag color={statusColors[status]}>{periodLabels[status]}</Tag>;
}

export function Workflow({ user, periods, page, setPage, refreshPeriods, openSettings, dirty }) {
  const [showTrash, setTrash] = useState(false);
  function open(next) {
    setPage(next);
    window.scrollTo(0, 0);
  }
  const back = () => open(null);

  if (page?.type === 'create') {
    return <Card>
      <div className="row-between"><Heading help="period">新建排班周期</Heading><Button onClick={back}>取消</Button></div>
      <NewPeriod openSettings={openSettings} saved={period => {
        open({ type: 'detail', period, step: 'requirements' });
        refreshPeriods();
      }} />
    </Card>;
  }

  if (page?.type === 'detail') {
    const period = periods.find(p => p.id === page.period.id) || page.period;
    return <PeriodDetail key={period.id} user={user} period={period} step={page.step}
      changeStep={step => open({ ...page, step })} back={back} refreshPeriods={refreshPeriods}
      openSettings={openSettings} dirty={dirty} />;
  }

  return <>
    <Card>
      <div className="row-between">
        <Heading>安排排班</Heading>
        <Button type="primary" onClick={() => open({ type: 'create' })}>＋ 新建排班</Button>
      </div>
      {user.role === 'super_admin' && <Button onClick={() => setTrash(true)}>周期回收站</Button>}
    </Card>
    {user.role !== 'super_admin' && <Card>
      <div className="row-between">
        <Heading>基础设置</Heading>
        <Button onClick={() => openSettings()}>进入设置</Button>
      </div>
      <p className="muted">管理工作类型、班次和人员账号</p>
    </Card>}
    <Card title="排班周期">
      {periods.length ? <div className="stack">{periods.map(period => (
        <button type="button" className="choice period-list-item" key={period.id}
          onClick={() => open({ type: 'detail', period })}>
          <span className="row-between"><strong>{period.name}</strong><PeriodBadge period={period} /></span>
          <span className="muted">{period.startDate} 至 {period.endDate}</span>
          <span className="row-between">
            <span className="muted">{period.publishedRun
              ? `已安排 ${period.publishedRun.totalFilled}/${period.publishedRun.totalNeeded} 人次`
              : `已报名 ${period.enrolledCount} 人`}</span>
            <span className="period-list-link">查看详情 ›</span>
          </span>
        </button>
      ))}</div> : <Blank>暂无排班周期</Blank>}
    </Card>
    {showTrash && <Trash close={() => setTrash(false)} restored={refreshPeriods} />}
  </>;
}

function periodProgress(period, prep) {
  if (period.status === 'archived') return { step: 'published', label: '已归档，仅供查看' };
  if (prep.publishedRunId || period.status === 'published') return { step: 'published', label: '排班已生效' };
  if (prep.draftRunId) return { step: 'generate', label: '草稿待发布' };
  if (prep.nextStep === 'requirements') return { step: 'requirements', label: '待确认需求' };
  if (period.status === 'enrolling') return { step: 'people', label: '正在收集报名' };
  if (prep.canGenerate) return { step: 'generate', label: '待生成草稿' };
  return { step: 'people', label: '待确认参与人员' };
}

function PeriodDetail({ user, period, step, changeStep, back, refreshPeriods, openSettings, dirty }) {
  const prep = usePageLoad(period.id, () => API.periodPreparation(period.id), true);
  const [proxy, setProxy] = useState(false);
  const { run, busy, confirm } = useAction();

  async function leave() {
    if (dirty.current && !await confirm('放弃未保存的需求？')) return false;
    dirty.current = false;
    return true;
  }
  async function go(next) {
    if (await leave()) changeStep(next);
  }
  async function removePeriod() {
    const warning = `「${period.name}」的排班、报名和换班将隐藏，超级管理员可在回收站恢复。`;
    if (!await confirm('删除排班周期？', warning + (dirty.current ? '未保存的需求也会丢失。' : ''), true)) return;
    await run(() => API.deletePeriod(period.id), '周期已移入回收站', () => {
      dirty.current = false;
      back();
      refreshPeriods();
    });
  }
  const refresh = () => { prep.refresh(); refreshPeriods(); };
  async function afterRequirements() {
    const next = await API.periodPreparation(period.id);
    prep.refresh();
    const issue = next.blockers.find(b => b.step === 'requirements');
    if (!next.totalNeeded || issue) throw new Error(issue?.message || '请至少填写一项需求');
    await go('people');
  }

  const backButton = <Button type="link" className="period-back" onClick={async () => {
    if (await leave()) back();
  }}>← 返回排班列表</Button>;
  if (!prep.data || prep.error) return <Card>{backButton}<Load query={prep} /></Card>;

  const preparation = prep.data;
  const current = preparation.period;
  const progress = periodProgress(current, preparation);
  const activeStep = step || progress.step;
  const archived = current.status === 'archived';
  const published = current.status === 'published' || !!preparation.publishedRunId;
  const readOnly = archived || published;
  const canDelete = !published || archived || user.role === 'super_admin';
  const lastStep = readOnly ? 'published' : 'generate';
  const steps = [
    { key: 'period', title: '周期设置' },
    { key: 'requirements', title: '排班需求' },
    { key: 'people', title: '参与人员' },
    { key: lastStep, title: archived ? '历史排班' : published ? '生效排班' : '生成发布' },
  ];
  const selectedIndex = steps.findIndex(item => item.key === activeStep);
  const currentIndex = selectedIndex < 0 ? steps.length - 1 : selectedIndex;
  const progressIndex = steps.findIndex(item => item.key === progress.step);
  let content;
  if (activeStep === 'period') {
    content = readOnly ? <PeriodSettingsSummary period={current} /> : <Card><Heading help="period">周期设置</Heading>
      <Collapse items={[
        { key: 'settings', label: '编辑当前周期',
          children: <PeriodForm key={current.id} period={current} saved={() => { refresh(); void go('requirements'); }} /> },
        { key: 'status', label: '周期状态与归档',
          children: <PeriodStatus key={`${current.status}:${preparation.draftRunId ?? ''}`} period={current}
            hasDraft={!!preparation.draftRunId} saved={() => { refresh(); void go(null); }} /> },
      ]} />
    </Card>;
  } else if (activeStep === 'requirements') {
    content = <Requirements period={current} readOnly={readOnly} dirty={dirty} saved={afterRequirements} />;
  } else if (activeStep === 'people') {
    content = <People period={current} prep={preparation} readOnly={readOnly} openProxy={() => setProxy(true)} go={go} refresh={refresh} />;
  } else if (activeStep === 'published') {
    content = <PublishedSchedule period={current} user={user} refresh={refresh}
      openDraft={preparation.draftRunId ? () => go('generate') : undefined} />;
  } else {
    content = <DraftSchedule period={current} prep={preparation} user={user} readOnly={readOnly}
      refresh={refresh} go={go} openSettings={openSettings} />;
  }

  return <>
    <Card>
      {backButton}
      <div className="row-between">
        <Heading>{current.name}</Heading>
        {canDelete && <Button type="text" danger loading={busy} onClick={removePeriod}>删除本周期</Button>}
      </div>
      <div className="inline"><PeriodBadge period={current} hasDraft={!!preparation.draftRunId} /><span className="muted">{current.startDate} 至 {current.endDate}</span></div>
      <nav aria-label="排班流程">
        <Steps className="workflow-steps period-steps" current={currentIndex} size="small" labelPlacement="vertical" responsive={false}
          onChange={index => go(steps[index].key)} items={steps.map((item, index) => ({
            ...item,
            'aria-current': index === currentIndex ? 'step' : undefined,
            status: published || (!archived && index < progressIndex) ? 'finish'
              : index === progressIndex ? 'process' : 'wait',
          }))} />
      </nav>
      <Alert className="period-progress" message={progress.label}
        description={`需求 ${preparation.publishedTotalNeeded ?? preparation.totalNeeded} 人次 · 匹配需求 ${preparation.participants.length} 人`} />
    </Card>
    {content}
    {proxy && !readOnly && <ProxyEnrollment currentUserId={user.id} period={current} close={() => setProxy(false)} saved={() => { setProxy(false); refresh(); }} />}
  </>;
}

function PeriodSettingsSummary({ period }) {
  return <Card><Heading help="period">周期设置</Heading>
    <div className="stack">
      <div>每人每天最多 {period.maxShiftsPerDay} 班</div>
      <div>每人每周最多 {period.maxShiftsPerWeek} 班</div>
      <div>{period.forbidConsecutive ? '禁止' : '允许'}同一天连续班次</div>
    </div>
  </Card>;
}

function People({ period, prep, readOnly, openProxy, go, refresh }) {
  const { run, busy } = useAction();
  return <Card><Heading help="participants">参与人员</Heading><div className="stack">
    <div className="muted">匹配需求 {prep.participants.length} 人 · 本期已报名 {prep.submittedCount} 人 · 长期固定 {prep.fixedCount} 人</div>
    <Collapse items={[{ key: 'people', label: '参与名单', children: prep.participants.length
      ? prep.participants.map(u => <div className="choice" key={u.userId}>
        <div className="inline">
          <span>{u.name}（{u.employeeNo}）</span>
          {u.hasFixed && <Tag>长期固定</Tag>}
          {u.hasSubmitted && <Tag color="green">本期报名</Tag>}
          {u.maxShifts === 0 && <Tag>本期不接班</Tag>}
          {u.submittedAt && <span className="muted">报名时间 {timeText(u.submittedAt)}</span>}
        </div>
        {!!u.workTypes?.length && <Space wrap size={[4, 4]} className="participant-work-tags">
          {u.workTypes.map(work => <Tag key={work.id} color={work.fixedOnly ? undefined : 'blue'}>{work.name}{work.fixedOnly && ' · 固定'}</Tag>)}
        </Space>}
      </div>)
      : <Blank>暂无参与人员</Blank> }]} />
    {!readOnly && <>
      <Space wrap>
        {period.status === 'draft' && !prep.draftRunId && prep.totalNeeded > 0 && <Button loading={busy} onClick={() => run(() => API.updatePeriod(period.id, { status: 'enrolling' }), '已开放本人报名', refresh)}>开放本人报名</Button>}
        <Button onClick={openProxy}>代报名</Button>
      </Space>
      {prep.canGenerate
        ? <Button type="primary" onClick={() => go('generate')}>进入生成排班</Button>
        : <Alert type="warning" message={prep.blockers[0]?.message || '当前还不能生成排班'} />}
    </>}
  </div></Card>;
}

function NewPeriod({ openSettings, saved }) {
  const query = useLoad('scope', () => Promise.all([API.workTypes(), API.shifts()]));
  return <Load query={query}>{([works, shifts]) => {
    const activeWorks = works.filter(w => w.active), activeShifts = shifts.filter(s => s.active);
    return activeWorks.length && activeShifts.length ? <PeriodForm works={activeWorks} shifts={activeShifts} saved={saved} /> : <div className="stack">
      <Alert type="warning" showIcon message="请先配置本次需要的工作和班次" />
      <Space wrap>{!activeWorks.length && <Button type="primary" onClick={() => openSettings('worktypes')}>设置工作</Button>}{!activeShifts.length && <Button type="primary" onClick={() => openSettings('shifts')}>设置班次</Button>}</Space>
    </div>;
  }}</Load>;
}

function PeriodForm({ period, works, shifts, saved }) {
  const [form] = Form.useForm();
  const duration = Form.useWatch('duration', form) || (period ? 'custom' : 'week');
  const start = iso(Form.useWatch('startDate', form));
  const range = useLoad(start && duration !== 'custom' ? start + '|' + duration : null, () => API.periodRange(start, duration));
  const { run, busy } = useAction();
  useEffect(() => {
    if (range.data) form.setFieldValue('endDate', dayjs(range.data.endDate));
  }, [range.data, form]);
  const locked = period && ['published', 'archived'].includes(period.status);
  const initialValues = { maxShiftsPerDay: 1, maxShiftsPerWeek: 5, forbidConsecutive: true, ...period, duration: period ? 'custom' : 'week', startDate: dayjs(period?.startDate || today()), endDate: period ? dayjs(period.endDate) : dayjs(today()).add(6, 'day') };
  function save(v) {
    const fields = { name: v.name.trim(), startDate: iso(v.startDate), endDate: iso(v.endDate), maxShiftsPerDay: v.maxShiftsPerDay, maxShiftsPerWeek: v.maxShiftsPerWeek, forbidConsecutive: v.forbidConsecutive };
    return run(() => period ? API.updatePeriod(period.id, fields) : API.createPeriod({ ...fields, initializeRequirements: true, workTypeIds: v.workTypeIds, shiftIds: v.shiftIds }), period ? '周期设置已保存' : '周期已创建，请确认需求', saved);
  }
  return <Form form={form} layout="vertical" initialValues={initialValues} requiredMark={false} disabled={locked || busy} onFinish={save}>
    <Form.Item label="周期名称" name="name" rules={required}><Input maxLength={64} /></Form.Item>
    <Form.Item label="周期长度" name="duration"><Select options={durations} /></Form.Item>
    <div className="form-grid">
      <Form.Item label="开始日期" name="startDate" rules={required}><DatePicker allowClear={false} /></Form.Item>
      <Form.Item label="结束日期" name="endDate" rules={required}><DatePicker allowClear={false} onChange={() => form.setFieldValue('duration', 'custom')} /></Form.Item>
    </div>
    {range.error && <Alert type="error" message={range.error.message} />}
    {!period && <>
      <Form.Item label="本次工作" name="workTypeIds" rules={[{ required: true, type: 'array', min: 1, message: '至少选择一项工作' }]}><Checkbox.Group options={works.map(w => option(w.id, w.name + (w.requiresRoles ? '（主 + 副）' : '')))} /></Form.Item>
      <Form.Item label="本次班次" name="shiftIds" rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个班次' }]}><Checkbox.Group options={shifts.map(s => option(s.id, shiftText(s)))} /></Form.Item>
    </>}
    <Collapse className="form-section" items={[{ key: 'constraints', label: '排班规则（可选）', forceRender: true, children: <>
      <div className="form-grid"><Form.Item name="maxShiftsPerDay" label="每人每天最多班次" rules={required}><InputNumber min={1} max={5} precision={0} /></Form.Item>
      <Form.Item name="maxShiftsPerWeek" label="每人每周最多班次" rules={required}><InputNumber min={1} max={21} precision={0} /></Form.Item></div>
      <Form.Item name="forbidConsecutive" valuePropName="checked"><Checkbox>禁止同一天连续班次</Checkbox></Form.Item>
    </> }]} />
    {!locked && <Button type="primary" htmlType="submit" loading={busy || range.loading} disabled={!!range.error}>{period ? '保存周期设置' : '创建并确认需求'}</Button>}
  </Form>;
}
function PeriodStatus({ period, hasDraft, saved }) {
  const [status, setStatus] = useState(period.status);
  const { run, busy, confirm } = useAction();
  const allowed = transitions[period.status].filter(next => !hasDraft || next === 'archived');
  const currentLabel = hasDraft && period.status !== 'published' ? '草稿待发布' : periodLabels[period.status];
  const options = [option(period.status, currentLabel), ...allowed.map(next => option(next, periodLabels[next]))];
  return <Form layout="vertical" onFinish={async () => {
    if (status !== 'archived' || await confirm('归档排班周期？', '归档后只能查看该周期。')) await run(() => API.updatePeriod(period.id, { status }), '周期状态已更新', saved);
  }}>
    <Field label="周期状态"><Select aria-label="周期状态" value={status} onChange={setStatus} options={options} /></Field>
    <Button htmlType="submit" disabled={period.status === status} loading={busy}>更新周期状态</Button>
  </Form>;
}
function Trash({ close, restored }) {
  const query = useLoad('trash', API.deletedPeriods);
  const { run, busy, confirm } = useAction();
  return <Modal open title="周期回收站" onCancel={close} footer={null}><Load query={query}>{items => items.length ? items.map(p => <div className="choice row-between" key={p.id}>
    <div><strong>{p.name}</strong><div className="muted">{p.startDate} 至 {p.endDate} · {periodLabels[p.status]}</div><div className="muted">{p.deletedByName && p.deletedByName + " · "}删除于 {timeText(p.deletedAt)}</div></div>
    <Button loading={busy} onClick={async () => { if (await confirm('恢复排班周期？', p.name)) await run(() => API.restorePeriod(p.id), '周期已恢复', () => { query.refresh(); restored(p.id); }); }}>恢复</Button>
  </div>) : <Blank>回收站为空</Blank>}</Load></Modal>;
}

function Requirements({ period, readOnly, dirty, saved }) {
  const query = usePageLoad(period.id, () => API.requirements(period.id));
  return <Card><Heading help="requirements">排班需求</Heading>
    <Load query={query}>{data => <RequirementCalendar data={data} readOnly={readOnly} dirty={dirty} saved={saved} refresh={query.refresh} />}</Load>
  </Card>;
}

function RequirementCalendar({ data, readOnly, dirty, saved, refresh }) {
  const [month, setMonth] = useState(monthOf(data.dates[0]?.workDate));
  const [date, setDate] = useState(null);
  const [work, setWork] = useState(data.workTypes[0]?.id || 'all');
  const [edits, setEdits] = useState({});
  const { run, busy, confirm } = useAction();
  const locked = readOnly || ['published', 'archived'].includes(data.period.status);
  const hasSlots = data.dates.length > 0;
  const pending = Object.values(edits);
  const summary = !hasSlots ? '尚未填充需求' : pending.length ? '需求待保存' : !locked && data.matchesDefaultRules ? '已按默认规则填充' : '本周期需求';
  const days = new Map(data.dates.map(day => [day.workDate, day]));
  const workTypes = new Map(data.workTypes.map(type => [type.id, type]));
  const totalNeeded = pending.reduce((total, edit) => {
    const shift = days.get(edit.workDate).shifts.find(s => s.shiftId === edit.shiftId);
    const original = shift.requirements.find(r => r.workTypeId === edit.workTypeId).needCount;
    return total + edit.needCount - original;
  }, data.totalNeeded);
  const visibleRequirements = shift => shift.requirements.filter(r => r.allowed !== false && (work === 'all' || r.workTypeId === work));
  const requirementKey = (day, shiftId, workTypeId) => `${day}|${shiftId}|${workTypeId}`;
  const needCount = (day, shiftId, requirement) => edits[requirementKey(day, shiftId, requirement.workTypeId)]?.needCount ?? requirement.needCount;
  const dayShifts = (days.get(date)?.shifts || []).filter(shift => visibleRequirements(shift).length);
  function dayInfo(day) {
    const entry = days.get(day);
    if (!entry) return;
    const count = entry.shifts.reduce((total, shift) => total + visibleRequirements(shift)
      .reduce((sum, requirement) => sum + needCount(day, shift.shiftId, requirement), 0), 0);
    return { label: `${count} 人次需求`, badge: count > 0 && <small className="calendar-count">{count}</small> };
  }
  function editRequirement(shiftId, requirement, count) {
    if (count == null) return;
    const { workTypeId } = requirement;
    const key = requirementKey(date, shiftId, workTypeId);
    const nextEdits = { ...edits };
    if (count === requirement.needCount) delete nextEdits[key];
    else nextEdits[key] = { workDate: date, shiftId, workTypeId, needCount: count };
    dirty.current = Object.keys(nextEdits).length > 0;
    setEdits(nextEdits);
  }
  async function initialize(reset) {
    if (reset && !await confirm('重新按默认规则填充？', '会覆盖本周期的手工人数。', true)) return;
    await run(() => reset ? API.applyWorkRules(data.period.id) : API.preparePeriod(data.period.id), '需求已更新', () => { dirty.current = false; refresh(); });
  }
  async function next() {
    await run(async () => {
      if (pending.length) await API.saveRequirements(data.period.id, pending);
      dirty.current = false;
      setEdits({});
      try { await saved(); } catch (error) { refresh(); throw error; }
    });
  }
  return <div className="stack">
    <Alert message={hasSlots ? `${summary} · ${totalNeeded} 人次` : summary} />
    {!hasSlots && !locked && <Button type="primary" onClick={() => initialize(false)} loading={busy}>按默认规则填充</Button>}
    {hasSlots && <Collapse className="compact-calendar" items={[{
      key: 'details',
      label: locked ? '查看需求明细' : '查看或调整明细',
      children: <div className="stack">
        <Form layout="vertical">
          <Field label="工作类型"><Select aria-label="工作类型" value={work} onChange={setWork} options={[option('all', '全部工作'), ...data.workTypes.map(w => option(w.id, w.name))]} /></Field>
        </Form>
        <MonthCalendar month={month} startDate={data.period.startDate} endDate={data.period.endDate}
          move={setMonth} selected={date} pick={setDate} blocked={day => !days.has(iso(day))} dayInfo={dayInfo} />
        {!locked && <Button onClick={() => initialize(true)} loading={busy}>重新按默认规则填充</Button>}
      </div>,
    }]} />}
    {!locked && hasSlots && <Button type="primary" onClick={next} loading={busy}>
      {pending.length ? '保存需求，下一步' : '下一步：参与人员'}
    </Button>}
    <Modal open={!!date} title={date && `${dateText(date)} · 排班需求`} onCancel={() => setDate(null)}
      footer={<Button type="primary" onClick={() => setDate(null)}>{locked ? '关闭' : '完成'}</Button>}>
      <div className="stack">{dayShifts.length ? dayShifts.map(shift => (
        <section className="choice" key={shift.shiftId}>
          <h3>{shiftText(shift)}</h3>
          <div className="stack">{visibleRequirements(shift).map(requirement => {
            const type = workTypes.get(requirement.workTypeId);
            const count = needCount(date, shift.shiftId, requirement);
            return <div className="row-between requirement-row" key={requirement.workTypeId}>
              <span>{type.name}{type.requiresRoles && '（主 + 副）'}{type.fillAllEnrolled && ' · 最低人数'}</span>
              {locked ? <strong>{count} 人</strong> : <InputNumber
                aria-label={`${date} ${shift.shiftName} ${type.name}需求人数`} className="demand-number"
                disabled={busy} value={count} min={0} max={99} precision={0}
                onChange={value => editRequirement(shift.shiftId, requirement, value)} />}
            </div>;
          })}</div>
        </section>
      )) : <Blank>当天没有所选工作的需求</Blank>}</div>
    </Modal>
  </div>;
}

const publishSteps = [{ title: '生成草稿' }, { title: '核对草稿' }, { title: '确认发布' }];

function draftHasRoleGaps(draft) {
  return draft.matrix.some(d => d.shifts.some(s => s.workTypes.some(w => w.roleGaps?.length)));
}

function DraftSchedule({ period, prep, user, readOnly, refresh, go, openSettings }) {
  const query = useLoad(period.id, () => API.schedule(period.id, 'draft'));
  const [review, setReview] = useState(null);
  const [adjusting, setAdjusting] = useState(false);
  const [draftOverride, setDraftOverride] = useState(null);
  usePullRefresh(async () => {
    const refreshed = await query.refreshPage();
    if (refreshed) setDraftOverride(null);
    return refreshed;
  }, !review);
  const [editingOptions, setEditingOptions] = useState(false);
  const [detailView, setDetailView] = useState('calendar');
  const [seed, setSeed] = useState(42);
  const [historyChoice, setHistoryChoice] = useState();
  const { run, busy, confirm } = useAction();
  const draft = draftOverride || query.data;
  const hasDraft = !!draft?.run;
  const referenceHistory = historyChoice ?? draft?.run?.referenceHistory ?? true;
  const stage = review ? 2 : hasDraft && !editingOptions ? 1 : 0;
  const canPublish = hasDraft && !draftHasRoleGaps(draft) && !draft.gaps?.fixedConflicts?.length;

  function reload() {
    setDraftOverride(null);
    query.refresh();
    refresh();
  }
  function returnToDraft() {
    setReview(null);
    setEditingOptions(false);
    window.scrollTo(0, 0);
  }
  async function generate() {
    if (hasDraft && !await confirm('重新生成草稿？', '这会替换当前草稿及其中的手工调配。')) return;
    await run(() => API.generate(period.id, seed ?? 42, referenceHistory),
      result => `草稿已生成 · 已排 ${result.gaps.totalFilled}/${result.gaps.totalNeeded}`,
      () => { returnToDraft(); reload(); });
  }
  function openReview() {
    return run(async () => {
      const [nextDraft, published] = await Promise.all([API.schedule(period.id, 'draft'), API.schedule(period.id, 'published')]);
      if (!nextDraft.run || nextDraft.run.id !== draft.run.id || nextDraft.run.revision !== draft.run.revision) {
        reload();
        throw new Error('草稿已变更，请重新核对');
      }
      if (draftHasRoleGaps(nextDraft) || nextDraft.gaps?.fixedConflicts?.length) throw new Error('请先处理草稿中的固定人员冲突或主副缺口');
      setReview({ draft: nextDraft, published });
      window.scrollTo(0, 0);
    });
  }

  return <>
    <Card>
      <div className="row-between">
        <Heading help="generation">{readOnly ? '排班草稿' : '生成与发布'}</Heading>
        {readOnly && <Button onClick={() => go('published')}>返回排班</Button>}
      </div>
      {!readOnly && <Steps className="workflow-steps" current={stage} size="small" labelPlacement="vertical" responsive={false} items={publishSteps} />}
      <Load query={query}>{() => {
        if (readOnly) return hasDraft ? <DraftDetails draft={draft} user={user} view={detailView} setView={setDetailView} /> : <Blank>本周期暂无草稿</Blank>;
        if (review) return <PublishReview data={review} period={period} user={user} view={detailView} setView={setDetailView} back={returnToDraft} saved={() => {
          refresh();
          void go('published');
        }} />;
        if (stage === 1) return <section className="stack" aria-label="核对草稿">
          <DraftDetails draft={draft} user={user} view={detailView} setView={setDetailView} />
          <Space wrap>
            {prep.canGenerate && <Button disabled={busy} onClick={() => { setEditingOptions(true); window.scrollTo(0, 0); }}>调整生成设置</Button>}
            <Button disabled={busy} onClick={() => setAdjusting(true)}>手工调配草稿</Button>
            <Button type="primary" loading={busy} disabled={!canPublish} onClick={openReview}>下一步：确认发布</Button>
          </Space>
        </section>;
        return <Form layout="vertical" className="stack" onFinish={generate}>
          <div className="choice">
            <strong>{period.name}</strong>
            <div className="muted">{period.startDate} 至 {period.endDate}</div>
            <div className="muted">需求 {prep.totalNeeded} 人次 · 匹配人员 {prep.participants.length} 人</div>
          </div>
          {prep.blockers.map(b => <Alert key={b.message} type="warning" message={b.message}
            action={<Button onClick={() => b.configTab ? openSettings(b.configTab) : go(b.step)}>去处理</Button>} />)}
          {prep.canGenerate && <div>
            <Checkbox checked={referenceHistory} disabled={busy} onChange={event => setHistoryChoice(event.target.checked)}>参考历史排班</Checkbox>
            <p className="muted">优先轮给较久没做这项工作的人，兼顾总班次。</p>
          </div>}
          {prep.canGenerate && <Collapse items={[{ key: 'seed', label: '生成设置（可选）', children:
            <Field label="随机种子"><InputNumber aria-label="随机种子" value={seed} onChange={setSeed} precision={0} disabled={busy} /></Field>,
          }]} />}
          <Space wrap>
            {hasDraft && <Button disabled={busy} onClick={returnToDraft}>返回草稿</Button>}
            <Button type="primary" htmlType="submit" disabled={!prep.canGenerate} loading={busy}>{hasDraft ? '重新生成草稿' : '生成草稿'}</Button>
          </Space>
        </Form>;
      }}</Load>
    </Card>
    {hasDraft && stage === 1 && <Records metrics={draft.metrics} />}
    {adjusting && !readOnly && <Adjustments mode="draft" currentUserId={user.id} data={draft} close={() => setAdjusting(false)} saved={setDraftOverride} />}
  </>;
}

function DraftDetails({ draft, user, view, setView }) {
  const conflicts = draft.gaps?.fixedConflicts || [];
  const { totalFilled, totalNeeded } = draft.run;
  const totalGap = draft.gaps?.totalGap ?? Math.max(0, totalNeeded - totalFilled);
  return <div className="stack">
    <Alert message={`草稿 #${draft.run.id} · 已排 ${totalFilled} 人次 · 需求 ${totalNeeded} 人次 · 缺口 ${totalGap} 人次`} />
    {draftHasRoleGaps(draft) && <Alert showIcon type="error" message="主副负责人未配齐，暂不可发布" />}
    {conflicts.map((c, i) => <Alert key={i} type="error" message={`${c.workDate} ${c.name || ''}：${c.message}`} />)}
    <ScheduleDetailViews data={draft} user={user} view={view} setView={setView} />
  </div>;
}

function ScheduleDetailViews({ data, user, view, setView, published = false, onAdjustWork }) {
  return <Collapse className="compact-calendar" defaultActiveKey={published ? ['details'] : undefined} items={[{
    key: 'details', label: published ? '查看生效明细' : '查看草稿明细',
    children: <ScheduleDetails data={data} user={user} view={view} setView={setView} published={published} onAdjustWork={onAdjustWork} />,
  }]} />;
}

function PublishReview({ data, period, user, view, setView, back, saved }) {
  const { draft, published } = data;
  const { run, busy } = useAction();
  const [confirmed, setConfirmed] = useState(false);
  const totalGap = draft.gaps?.totalGap ?? Math.max(0, draft.run.totalNeeded - draft.run.totalFilled);
  const key = a => [a.workDate, a.shiftId, a.workTypeId, a.dutyRole || 'member', a.userId].join('|');
  const old = published.assignments || [];
  const oldKeys = new Set(old.map(key)), newKeys = new Set(draft.assignments.map(key));
  const added = draft.assignments.filter(a => !oldKeys.has(key(a))), removed = old.filter(a => !newKeys.has(key(a)));
  function publish() {
    if (!confirmed) return;
    return run(() => API.publish(period.id, draft.run.id, draft.run.revision, published.run?.id || 0, published.run?.revision || 0),
      result => result.alreadyPublished ? '该排班已发布' : `发布成功 · ${result.filled} 条排班生效`, saved);
  }
  return <Form layout="vertical" className="stack" onFinish={publish}>
    <Alert message={`${period.name} · 草稿 #${draft.run.id} · ${draft.assignments.length} 人次`}
      description={published.run ? `发布后将替换生效版本 #${published.run.id}` : '首次发布后，团队成员即可查看安排。'} />
    {totalGap > 0 && <Alert type="warning" showIcon message={`仍有 ${totalGap} 人次缺口`} />}
    <ScheduleDetailViews data={draft} user={user} view={view} setView={setView} />
    <div className="muted">新增或调整 {added.length} 项 · 移出 {removed.length} 项 · 保留 {draft.assignments.length - added.length} 项</div>
    <Collapse items={[['新增或调整', added], ['移出', removed]].map(([title, rows]) => ({
      key: title, label: `${title}（${rows.length}）`,
      children: rows.length ? <div className="review-changes">{rows.map(a => <div className="choice" key={key(a)}>{a.name} · {assignmentLabel(a)}</div>)}</div> : <span className="muted">无</span>,
    }))} />
    <Checkbox checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}>我已核对本次排班，确认发布后生效</Checkbox>
    <Space wrap>
      <Button disabled={busy} onClick={back}>上一步：核对草稿</Button>
      <Button type="primary" htmlType="submit" loading={busy} disabled={!confirmed}>确认发布</Button>
    </Space>
  </Form>;
}

function PublishedSchedule({ period, user, openDraft, refresh }) {
  const [adjusting, setAdjusting] = useState(null);
  const [detailView, setDetailView] = useState('calendar');
  const query = usePageLoad(period.id, () => Promise.all([
    API.schedule(period.id, 'published'), API.adminSwaps(period.id), API.get(`/enrollments/${period.id}`),
  ]), true);
  const archived = period.status === 'archived';
  const canAdjust = period.status === 'published' && ['admin', 'super_admin'].includes(user.role);
  function afterAdjustment() {
    setAdjusting(null);
    query.refresh();
    refresh();
  }
  return <Load query={query}>{([published, swaps, stats]) => <>
    {published.run && <div className="stat-grid">{[
      ['参与人数', `${stats.effectiveCount ?? stats.submittedCount}/${stats.totalEmployees}`],
      ['已排 / 需求', `${published.run.totalFilled}/${published.run.totalNeeded}`],
      ['填充率', `${(published.run.fillRate * 100).toFixed(0)}%`],
      ['待确认换班', swaps.filter(s => s.status === 'pending').length],
    ].map(([title, value]) => <Card size="small" key={title}><Statistic title={title} value={value} /></Card>)}</div>}
    <Card><div className="row-between">
      <Heading help="published">{archived ? '历史排班' : '生效排班'}</Heading>
      <Space wrap>
        {openDraft && <Button onClick={openDraft}>查看草稿</Button>}
        {canAdjust && published.run && <Button type="primary" disabled={query.loading} onClick={() => setAdjusting({})}>手动调班</Button>}
      </Space>
    </div>{published.run ? <div className="stack">
      <Alert message={`生效版本 #${published.run.id} · 已安排 ${published.assignments.length} 人次`} />
      <ScheduleDetailViews data={published} user={user} view={detailView} setView={setDetailView} published
        onAdjustWork={canAdjust && !query.loading ? setAdjusting : undefined} />
    </div> : <Blank>本周期暂无已发布排班</Blank>}</Card>
    <Records metrics={published.metrics} swaps={swaps} revision={published.run?.revision} />
    {adjusting && canAdjust && <Adjustments mode="published" currentUserId={user.id} data={published} target={adjusting} close={() => setAdjusting(null)} saved={afterAdjustment} />}
  </>}</Load>;
}

function Records({ metrics, swaps, revision }) {
  const [active, setActive] = useState([]);
  const audit = usePageLoad(active.includes('audit') ? revision ?? 'audit' : null, () => API.auditLogs(15));
  return <Card><Heading help="fairness">统计与记录</Heading><Collapse activeKey={active} onChange={setActive} items={[
    ...(metrics ? [{ key: 'metrics', label: `公平度 · ${metrics.fairnessScore} 分`, children: <>
      <p>工作量：人均 {metrics.workload.avg} 班 · 标准差 {metrics.workload.std} · 最多 {metrics.workload.max} / 最少 {metrics.workload.min}</p>
      {metrics.perWorkType.map(w => <div className="choice" key={w.workTypeId}><strong>{w.workTypeName}</strong><p>{w.eligibleCount} 人可胜任 · 已排 {w.totalAssigned} · 标准差 {w.std} · 极差 {w.range}</p>{w.distribution.map(d => <Tag key={d.userId || d.name}>{d.name} {d.count}</Tag>)}</div>)}
      <div className="choice"><strong>工作量分布</strong><div>{metrics.workload.distribution.map(d => <Tag key={d.userId || d.name}>{d.name} {d.assigned} 班</Tag>)}</div></div>
    </> }] : []),
    ...(swaps ? [{ key: 'swaps', label: `换班记录（${swaps.length}）`, children: swaps.length ? swaps.map(s => <div className="choice" key={s.id}><Tag>{swapLabels[s.status]}</Tag>{s.requesterName} → {s.toUserName}<div>{s.fromWorkDate} · {s.fromShiftName} · {s.fromWorkTypeName}</div>{s.toWorkDate && <div>互换：{s.toWorkDate} · {s.toShiftName} · {s.toWorkTypeName}</div>}</div>) : <Blank>暂无换班记录</Blank> }] : []),
    { key: 'audit', label: '操作日志', children: <Load query={audit}>{data => data.items.length ? data.items.map(it => <div className="choice row-between" key={it.id}><span>{it.actionLabel || it.action} · {it.actorName || '—'}</span><span className="muted">{timeText(it.createdAt)}</span></div>) : <Blank>暂无日志</Blank>}</Load> },
  ]} /></Card>;
}
