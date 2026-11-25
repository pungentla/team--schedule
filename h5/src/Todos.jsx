import React, { useEffect, useId, useRef, useState } from 'react';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import Collapse from 'antd/es/collapse';
import DatePicker from 'antd/es/date-picker';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Pagination from 'antd/es/pagination';
import Progress from 'antd/es/progress';
import Radio from 'antd/es/radio';
import Segmented from 'antd/es/segmented';
import Select from 'antd/es/select';
import Tag from 'antd/es/tag';
import CheckSquareOutlined from '@ant-design/icons/es/icons/CheckSquareOutlined';
import PlusOutlined from '@ant-design/icons/es/icons/PlusOutlined';
import CloseOutlined from '@ant-design/icons/es/icons/CloseOutlined';
import { API, Blank, Heading, Load, dayjs, isAdmin, option, personLabel, required, timeText, useAction, useLoad, usePageLoad } from './shared';

const repeatLabels = { none: '不重复', weekly: '每周重复', monthly: '每月重复' };
const overdue = todo => !todo.completedAt && !todo.archivedAt && todo.dueAt && Date.parse(todo.dueAt) < Date.now();
const completedLate = todo => todo.completedAt && todo.dueAt && Date.parse(todo.completedAt) > Date.parse(todo.dueAt);

function TodoStatus({ todo }) {
  return todo.archivedAt ? <Tag>已归档</Tag> : todo.completedAt ? <Tag color={completedLate(todo) ? 'orange' : 'green'}>{completedLate(todo) ? '逾期完成' : '已完成'}</Tag>
    : overdue(todo) ? <Tag color="red">已逾期</Tag> : <Tag color="blue">待完成</Tag>;
}

function TodoMeta({ todo, showStatus = true }) {
  return <div className="inline todo-meta">
    {showStatus && <TodoStatus todo={todo} />}
    {todo.priority === 'urgent' && <Tag color="volcano">紧急</Tag>}
    {todo.visibility === 'private' && <Tag color="purple">仅自己可见</Tag>}
    {todo.repeatKind !== 'none' && <Tag>{repeatLabels[todo.repeatKind]}</Tag>}
    <span className="muted">{todo.dueAt ? `截止 ${timeText(todo.dueAt)}` : '未设截止时间'}</span>
  </div>;
}

function TodoSummary({ todo, open }) {
  const finished = todo.items.filter(item => item.done).length;
  return <button type="button" className="todo-summary" onClick={() => open(todo.id)}>
    <div className="todo-card-heading"><strong>{todo.title}</strong><TodoStatus todo={todo} /></div>
    <TodoMeta todo={todo} showStatus={false} />
    {todo.description && <p className="muted todo-excerpt">{todo.description}</p>}
    <div className="inline"><span className="muted">执行人：{todo.assigneeName}</span>
      {todo.items.some(item => item.canComplete && item.assigneeId !== todo.assigneeId) && <Tag color="blue">我有子任务</Tag>}
      {todo.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}
    </div>
    {!!todo.items.length && <div className="todo-progress"><span className="muted">子任务 {finished}/{todo.items.length}</span>
      <Progress percent={Math.round(finished / todo.items.length * 100)} showInfo={false} size="small" /></div>}
  </button>;
}

export function WorkbenchTodos({ open }) {
  const query = usePageLoad('recent-todo', API.recentTodo);
  return <Card className={`todo-preview${query.data?.visibility === 'private' ? ' todo-private' : ''}`}><div className="row-between">
    <Heading><CheckSquareOutlined aria-hidden="true" /> 待办事项</Heading>
    <Button type="link" onClick={() => open()}>更多待办 ›</Button>
  </div>
    {query.data === null ? <p className="muted">暂无未完成待办，可以创建一项。</p>
      : <Load query={query}>{todo => <TodoSummary todo={todo} open={open} />}</Load>}
  </Card>;
}

export default function Todos({ user, detailId, open, back, refreshInbox }) {
  const [filters, setFilters] = useState({ scope: 'mine', status: 'pending', tag: '', keyword: '', page: 1 });
  const [creating, setCreating] = useState(false);
  const list = useRef(null);
  const query = usePageLoad(JSON.stringify(filters), () => API.todos(filters), true);
  const tagQuery = useLoad('todo-tags', API.todoTags, true);
  function refresh() { query.refresh(); tagQuery.refresh(); refreshInbox(); }
  function filter(changes) {
    setFilters(previous => ({ ...previous, ...changes, page: 1 }));
    list.current?.scrollTo({ top: 0 });
  }
  return <div className="todos-page">
    <Button type="link" className="period-back" onClick={back}>← 返回{user.role === 'super_admin' ? '安排排班' : '工作台'}</Button>
    <Card className="todo-list-controls"><div className="row-between">
      <Heading>待办事项</Heading>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>新建待办</Button>
    </div>
      <div className="stack">
        <Segmented block options={[option('mine', '与我有关'), option('public', '公开待办'), option('private', '仅自己可见')]} value={filters.scope} onChange={scope => filter({ scope })} />
        <div className="todo-filters">
          <Select aria-label="待办状态" value={filters.status} onChange={status => filter({ status })}
            options={[option('pending', '未完成'), option('overdue', '已逾期'), option('completed', '已完成'), option('archived', '已归档'), option('all', '全部状态')]} />
          <Select aria-label="筛选标签" value={filters.tag} showSearch optionFilterProp="label" onChange={tag => filter({ tag })}
            options={[option('', '全部标签'), ...(tagQuery.data ?? []).map(tag => option(tag, tag))]} />
          <Input.Search aria-label="搜索待办" placeholder="搜索标题或描述" maxLength={80} allowClear onSearch={keyword => filter({ keyword })} />
        </div>
      </div>
    </Card>
    <div ref={list} className="todo-list-scroll stack" role="region" aria-label="待办列表" tabIndex={0} data-pull-refresh-scroll>
    <Load query={query}>{data => <>
      {data.items.length ? data.items.map(todo => <Card key={todo.id} className={`todo-card${todo.visibility === 'private' ? ' todo-private' : ''}${overdue(todo) ? ' todo-overdue' : ''}`}>
        <TodoSummary todo={todo} open={open} />
      </Card>) : <Card><Blank>没有符合条件的待办</Blank></Card>}
      {data.total > data.pageSize && <Pagination align="center" current={filters.page} total={data.total} pageSize={data.pageSize} showSizeChanger={false}
        onChange={page => { setFilters(previous => ({ ...previous, page })); list.current?.scrollTo({ top: 0 }); }} />}
    </>}</Load>
    </div>
    {creating && <TodoEditor user={user} tags={tagQuery.data ?? []} close={() => setCreating(false)} saved={todo => {
      setCreating(false); refresh(); open(todo.id);
    }} />}
    {detailId != null && <TodoDetail key={detailId} id={detailId} user={user} tags={tagQuery.data ?? []}
      close={() => open()} changed={refresh} />}
  </div>;
}

function ReminderFields({ dueAt, disabled = false }) {
  const form = Form.useFormInstance();
  const choice = Form.useWatch('remindChoice', form) ?? 'none';
  return <>
    <Form.Item label="提醒" name="remindChoice"><Select disabled={disabled} options={[
      option('none', '不提醒'), { ...option('due', '截止时'), disabled: !dueAt },
      { ...option('hour', '提前1小时'), disabled: !dueAt }, { ...option('day', '提前1天'), disabled: !dueAt }, option('custom', '自定义时间'),
    ]} /></Form.Item>
    {choice === 'custom' && <Form.Item label="提醒时间" name="remindAt" rules={required}>
      <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" placeholder="选择提醒时间" className="full-width" />
    </Form.Item>}
  </>;
}

function reminderValue(values) {
  if (!values.remindChoice || values.remindChoice === 'none') return null;
  if (values.remindChoice === 'custom') return values.remindAt?.toISOString();
  if (!values.dueAt) throw new Error('请设置截止时间，或选择自定义提醒时间');
  const hours = { due: 0, hour: 1, day: 24 };
  return values.dueAt.subtract(hours[values.remindChoice], 'hour').toISOString();
}

function TodoEditor({ user, todo, tags, close, saved }) {
  const [form] = Form.useForm();
  const formId = useId();
  const { run, busy } = useAction();
  const [expanded, setExpanded] = useState(() => todo && (todo.tags.length || todo.items.length || todo.priority === 'urgent' || todo.repeatKind !== 'none') ? ['extras'] : []);
  const people = useLoad(isAdmin(user) ? 'todo-assignees' : null, API.adminUsers);
  const assignee = Form.useWatch('assigneeId', form) ?? todo?.assigneeId ?? user.id;
  const visibility = Form.useWatch('visibility', form) ?? todo?.visibility ?? 'public';
  const dueAt = Form.useWatch('dueAt', form);
  const repeatKind = Form.useWatch('repeatKind', form) ?? 'none';
  const selectedTags = Form.useWatch('tags', form) ?? todo?.tags ?? [];
  const items = Form.useWatch('items', form) ?? todo?.items ?? [];
  const priority = Form.useWatch('priority', form) ?? todo?.priority ?? 'normal';
  const extraSummary = [priority === 'urgent' && '紧急', repeatKind !== 'none' && repeatLabels[repeatKind],
    selectedTags.length && `${selectedTags.length}个标签`, items.length && `${items.length}项子任务`].filter(Boolean).join(' · ');
  const assigned = assignee !== user.id;
  const shared = assigned || items.some(item => item?.assigneeId != null && item.assigneeId !== user.id);
  useEffect(() => { if (shared) form.setFieldValue('visibility', 'public'); }, [shared, form]);
  const initialValues = { title: todo?.title, description: todo?.description ?? '', priority: todo?.priority ?? 'normal',
    assigneeId: todo?.assigneeId ?? (user.role === 'super_admin' ? undefined : user.id), visibility: todo?.visibility ?? 'public',
    tags: todo?.tags ?? [], dueAt: todo?.dueAt ? dayjs(todo.dueAt) : null, repeatKind: todo?.repeatKind ?? 'none',
    items: todo?.items.map(item => ({ id: item.id, title: item.title, assigneeId: item.followAssignee ? null : item.assigneeId })) ?? [], remindChoice: 'none' };
  return <Modal open centered title={todo ? '修改待办' : '新建待办'} onCancel={() => !busy && close()} width={650} className="todo-editor-modal"
    footer={<><Button onClick={close} disabled={busy}>取消</Button>
      <Button type="primary" htmlType="submit" form={formId} loading={busy}>{todo ? '保存修改' : shared ? '创建并分配' : '创建待办'}</Button></>}>
    <Form id={formId} form={form} layout="horizontal" labelAlign="left" colon={false}
      labelCol={{ xs: { flex: '88px' } }} wrapperCol={{ xs: { flex: 1 } }}
      className="todo-editor-form" initialValues={initialValues} disabled={busy}
      onFinishFailed={({ errorFields }) => {
        if (errorFields.some(({ name }) => ['tags', 'items', 'repeatKind', 'priority'].includes(name[0]))) setExpanded(['extras']);
      }} onFinish={values => run(() => {
      const body = { ...values, dueAt: values.dueAt?.toISOString() ?? null };
      if (!todo) body.remindAt = reminderValue(values);
      return API.saveTodo(todo?.id, body);
    }, todo ? '待办已更新' : '待办已创建', saved)}>
      <section className="todo-editor-section" aria-label="事项内容">
        <h3>事项内容</h3>
        <Form.Item label="标题" name="title" rules={required}><Input placeholder="例如：准备本周聚会" maxLength={80} showCount /></Form.Item>
        <Form.Item label="描述" name="description"><Input.TextArea placeholder="补充具体要求（选填）" maxLength={4000} showCount autoSize={{ minRows: 2, maxRows: 5 }} /></Form.Item>
      </section>
      <section className="todo-editor-section" aria-label="执行与权限">
        <h3>执行与权限</h3>
        {people.error && <Alert type="error" message="人员加载失败" action={<Button size="small" onClick={people.refresh}>重试</Button>} />}
        {isAdmin(user) && <Form.Item label="主执行人" name="assigneeId" rules={required}>
          <Select showSearch optionFilterProp="label" loading={people.loading} placeholder="选择执行人"
            options={(people.data ?? []).filter(person => person.status === 'active' && person.role !== 'super_admin')
              .map(person => option(person.id, personLabel(person, user.id)))} />
        </Form.Item>}
        <Form.Item label="可见范围" name="visibility" hidden={shared}><Radio.Group options={[option('public', '全员可见'), option('private', '仅自己可见')]} /></Form.Item>
        <p className="muted todo-editor-hint">{shared ? '分配给他人的事项全员可见，子任务由各自执行人完成。' : visibility === 'private' ? '仅你可见，管理员也无法查看。' : '所有成员可查看，只有你能修改内容。'}</p>
      </section>
      <section className="todo-editor-section" aria-label="时间与提醒">
        <h3>时间与提醒{!todo && assigned && <small>提醒发送给主执行人</small>}</h3>
        <Form.Item label="截止时间" name="dueAt" dependencies={['repeatKind']}
          rules={[({ getFieldValue }) => ({ validator: (_, value) => getFieldValue('repeatKind') !== 'none' && !value
            ? Promise.reject(new Error('重复待办需要设置截止时间')) : Promise.resolve() })]}>
          <DatePicker placeholder="选填，未设置则不限时" showTime={{ format: 'HH:mm', defaultValue: dayjs().endOf('day') }} format="YYYY-MM-DD HH:mm" className="full-width" />
        </Form.Item>
        {!todo ? <ReminderFields dueAt={dueAt} /> : <p className="muted todo-editor-hint">个人提醒请在详情中通过“设置提醒”调整。</p>}
      </section>
      <Collapse className="todo-editor-extras" activeKey={expanded} onChange={setExpanded} items={[{ key: 'extras', forceRender: true,
        label: <span className="todo-extras-heading"><strong>更多设置</strong><small>{extraSummary || '标签、优先级、重复、子任务'}</small></span>,
        children: <>
          <Form.Item label="标签" name="tags" rules={[{ validator: (_, values) => (values ?? []).length <= 8 && (values ?? []).every(tag => tag.trim().length > 0 && tag.trim().length <= 20)
            ? Promise.resolve() : Promise.reject(new Error('最多8个标签，每个1至20个字符')) }]}>
            <Select mode="tags" tokenSeparators={['，', ',']} options={tags.map(tag => option(tag, tag))} placeholder="输入或选择标签" maxTagCount="responsive" />
          </Form.Item>
          <Form.Item label="优先级" name="priority"><Radio.Group options={[option('normal', '普通'), option('urgent', '紧急')]} /></Form.Item>
          <Form.Item label="重复" name="repeatKind"><Select options={Object.entries(repeatLabels).map(([value, label]) => option(value, label))} /></Form.Item>
          {repeatKind !== 'none' && <p className="muted todo-editor-hint">{repeatKind === 'weekly' ? '每周同一时间' : '每月同一天（不足该日期时取月末）'}自动生成下一条。选择“不重复”停止整组后续自动生成。</p>}
          <Form.List name="items">{(fields, { add, remove }) => <div className="todo-editor-items">
            <div className="row-between"><strong>子任务{fields.length ? ` · ${fields.length}项` : ''}</strong><Button type="link" disabled={fields.length >= 30} onClick={() => add({ title: '' })}>＋ 添加</Button></div>
            {!!fields.length && <p className="muted todo-editor-hint">{isAdmin(user) ? '可分别指定执行人，未指定则跟随主执行人。' : '子任务由你完成。'}全部子任务完成后，由主执行人确认完成。</p>}
            {fields.map(field => <div className="todo-item-editor" key={field.key}>
              <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
              <Form.Item name={[field.name, 'title']} rules={required}><Input placeholder={`子任务${field.name + 1}`} maxLength={120} aria-label={`子任务${field.name + 1}`} /></Form.Item>
              <Button type="text" icon={<CloseOutlined />} aria-label={`移除子任务${field.name + 1}`} onClick={() => remove(field.name)} />
              {isAdmin(user) && <Form.Item name={[field.name, 'assigneeId']} label="执行人" className="todo-item-assignee">
                <Select allowClear showSearch optionFilterProp="label" placeholder="跟随主执行人" aria-label={`子任务${field.name + 1}执行人`}
                  loading={people.loading} options={(people.data ?? []).filter(person => person.status === 'active' && person.role !== 'super_admin')
                    .map(person => option(person.id, personLabel(person, user.id)))} />
              </Form.Item>}
            </div>)}
          </div>}</Form.List>
        </>,
      }]} />
    </Form>
  </Modal>;
}

function TodoDetail({ id, user, tags, close, changed }) {
  const query = usePageLoad(id, () => API.todo(id), true);
  const { run, busy, confirm } = useAction();
  const [editing, setEditing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => { if (query.data) API.readTodo(id).then(changed, () => {}); }, [id, !!query.data]);
  function refresh() { query.refresh(); changed(); }
  async function remove(todo) {
    if (!await confirm('删除这项待办？', todo.repeatKind !== 'none'
      ? '本条待办及其提醒会删除，同时停止这一组后续自动生成。已经生成的其他待办会保留。' : '删除后无法恢复，对应提醒也会移除。', true, '删除')) return;
    run(() => API.deleteTodo(id), '待办已删除', () => { changed(); close(); });
  }
  async function archive(todo) {
    const restoring = !!todo.archivedAt;
    if (!await confirm(restoring ? '恢复这项待办？' : '归档这项逾期待办？', restoring
      ? '将恢复到未完成列表；需要提醒时，请重新设置。' : '本条将从工作台和未完成列表移出，暂停提醒；之后可恢复，不影响后续重复待办。')) return;
    run(() => API.archiveTodo(id, !restoring), restoring ? '待办已恢复' : '待办已归档', refresh);
  }
  return <>
    <Modal open title="待办详情" onCancel={() => !busy && close()} footer={null} width={650}>
      <Load query={query}>{todo => <div className="stack todo-detail">
        <div className="row-between"><h2>{todo.title}</h2>{todo.canEdit && !todo.archivedAt && <Button disabled={busy} onClick={() => setEditing(true)}>修改</Button>}</div>
        <TodoMeta todo={todo} />
        <p className="muted">{todo.creatorName}创建 · {timeText(todo.createdAt)}<br />执行人：{todo.assigneeName}</p>
        {todo.description && <p className="todo-description">{todo.description}</p>}
        {!!todo.tags.length && <div className="inline">{todo.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}</div>}
        {!!todo.items.length && <section><h3>子任务 {todo.items.filter(item => item.done).length}/{todo.items.length}</h3>
          <ul className="todo-checklist">{todo.items.map(item => <li key={item.id}><Checkbox checked={item.done}
            disabled={!item.canComplete || !!todo.completedAt || busy} onChange={event => run(() => API.setTodoItem(id, item.id, event.target.checked), null, refresh)}>{item.title}</Checkbox>
              <Tag color={item.assigneeId === user.id ? 'blue' : undefined}>{item.assigneeName}{item.assigneeId === user.id ? '（我）' : ''}</Tag></li>)}</ul>
        </section>}
        {todo.completedAt && <Alert type="success" showIcon message={`${completedLate(todo) ? '逾期完成' : '已完成'} · ${timeText(todo.completedAt)}`}
          description={todo.completionNote && <p className="todo-description">{todo.completionNote}</p>} />}
        {todo.archivedAt && <Alert type="info" showIcon message={`已归档 · ${timeText(todo.archivedAt)}`} description="本条已暂停提醒，不影响后续重复待办。" />}
        {todo.canRemind && !todo.completedAt && <div className="row-between"><span className="muted">我的提醒：{todo.remindAt ? `${timeText(todo.remindAt)}${todo.remindedAt ? '（已提醒）' : ''}` : '未设置'}</span>
          <Button type="link" disabled={busy} onClick={() => setReminding(true)}>设置提醒</Button></div>}
        <div className="row-between"><div className="inline">
          {todo.canComplete && (todo.completedAt ? <Button disabled={busy} onClick={() => run(() => API.completeTodo(id, false), '已恢复为未完成', refresh)}>恢复为未完成</Button>
            : <Button type="primary" icon={<CheckSquareOutlined />} disabled={busy || todo.items.some(item => !item.done)} onClick={() => setCompleting(true)}>{overdue(todo) ? '逾期完成' : '标记完成'}</Button>)}
          {todo.canArchive && (overdue(todo) || todo.archivedAt) && <Button disabled={busy} onClick={() => archive(todo)}>{todo.archivedAt ? '恢复待办' : '归档'}</Button>}
          <Button onClick={close} disabled={busy}>关闭</Button>
        </div>{todo.canEdit && <Button type="text" className="todo-delete" disabled={busy} onClick={() => remove(todo)}>删除</Button>}</div>
        {todo.canComplete && !todo.completedAt && todo.items.some(item => !item.done) && <p className="muted">还有 {todo.items.filter(item => !item.done).length} 项子任务未完成，全部完成后可确认。</p>}
      </div>}</Load>
    </Modal>
    {editing && query.data && <TodoEditor user={user} todo={query.data} tags={tags} close={() => setEditing(false)} saved={() => { setEditing(false); refresh(); }} />}
    {completing && <Modal open title="完成待办" onCancel={() => !busy && setCompleting(false)} okText="确认完成" cancelText="取消" confirmLoading={busy}
      onOk={() => run(() => API.completeTodo(id, true, note), '已完成', () => { setCompleting(false); refresh(); })}>
      <p className="todo-form-note">确认这项待办已完成；有子任务时，需要先由各执行人完成全部子任务。</p>
      <Input.TextArea aria-label="完成备注" placeholder="完成备注（选填）" value={note} onChange={event => setNote(event.target.value)} maxLength={1000} showCount autoSize={{ minRows: 3, maxRows: 6 }} />
    </Modal>}
    {reminding && query.data && <ReminderEditor todo={query.data} close={() => setReminding(false)} saved={() => { setReminding(false); refresh(); }} />}
  </>;
}

function ReminderEditor({ todo, close, saved }) {
  const { run, busy } = useAction();
  return <Modal open title="设置我的提醒" footer={null} onCancel={() => !busy && close()}>
    <Form layout="vertical" initialValues={{ remindChoice: todo.remindAt && !todo.remindedAt ? 'custom' : 'none',
      remindAt: todo.remindAt ? dayjs(todo.remindAt) : null, dueAt: todo.dueAt ? dayjs(todo.dueAt) : null }}
      disabled={busy} onFinish={values => run(() => API.setTodoReminder(todo.id, reminderValue(values)), '提醒已更新', saved)}>
      <Form.Item name="dueAt" hidden><Input /></Form.Item>
      <ReminderFields dueAt={todo.dueAt} />
      <p className="muted todo-form-note">提醒始终进入站内铃铛，并发送到你已开启推送的设备。每个待办只能设置一次提醒。</p>
      <div className="inline"><Button type="primary" htmlType="submit" loading={busy}>保存提醒</Button><Button onClick={close}>取消</Button></div>
    </Form>
  </Modal>;
}
