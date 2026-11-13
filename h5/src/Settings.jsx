import React from 'react';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import Collapse from 'antd/es/collapse';
import ColorPicker from 'antd/es/color-picker';
import Divider from 'antd/es/divider';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import InputNumber from 'antd/es/input-number';
import Select from 'antd/es/select';
import Tabs from 'antd/es/tabs';
import Tag from 'antd/es/tag';
import TimePicker from 'antd/es/time-picker';
import { API, Heading, Help, Load, accountRoles, dayjs, option, personLabel, required, roleOptions, shiftText, useAction, usePageLoad, weekdays } from './shared';

const days = [1, 2, 3, 4, 5, 6, 0];
const newCode = prefix => prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
const inputPassword = [{ required: true, min: 6, max: 128, message: '密码需为 6–128 位' }];

export function Settings({ user, tab, setTab, back, onSessionChanged }) {
  const query = usePageLoad('settings', () => Promise.all([API.workTypes(), API.shifts(), API.adminUsers()]));
  return <Card>
    <Button type="link" className="period-back" onClick={back}>← 返回安排排班</Button>
    <div className="row-between"><Heading>基础设置</Heading><Button onClick={query.refresh}>刷新</Button></div>
    <Load query={query}>{([works, shifts, users]) => <Tabs activeKey={tab} onChange={setTab} items={[
      { key: 'worktypes', label: '工作类型', children: <><div className="inline muted">设置工作日和默认人数 <Help name="worktypes" /></div><Collapse accordion destroyOnHidden items={[
        { key: 'new', label: '＋ 新增工作类型', children: <WorkForm currentUserId={user.id} users={users} shifts={shifts} saved={query.refresh} /> },
        ...works.map(w => ({ key: w.id, label: <>{w.name} · {w.active ? '启用' : '停用'} {w.fillAllEnrolled && <Tag>按报名安排</Tag>}{w.requiresRoles && <Tag color="blue">主 + 副</Tag>}{w.dutyPairs?.length > 0 && <Tag>{w.dutyPairs.length} 种搭配</Tag>}</>, children: <WorkForm currentUserId={user.id} work={w} users={users} shifts={shifts} saved={query.refresh} /> })),
      ]} /></> },
      { key: 'shifts', label: '班次', children: <><div className="inline muted">设置班次时间 <Help name="shifts" /></div><Collapse accordion destroyOnHidden items={[
        { key: 'new', label: '＋ 新增班次', children: <ShiftForm seq={Math.max(0, ...shifts.map(s => s.seq)) + 1} saved={query.refresh} /> },
        ...shifts.map(s => ({ key: s.id, label: shiftText(s) + (s.active ? ' · 启用' : ' · 停用'), children: <ShiftForm shift={s} saved={query.refresh} /> })),
      ]} /></> },
      { key: 'accounts', label: '账号', children: <><div className="inline muted">管理人员账号 <Help name="accounts" /></div><Collapse accordion destroyOnHidden items={[
        { key: 'new', label: '＋ 新建账号', children: <AccountForm user={user} saved={query.refresh} /> },
        ...users.map(u => ({ key: u.id, label: `${personLabel(u)}${u.nickname ? ` · 花名 ${u.nickname}${u.nicknameEnabled ? '' : '（已禁用）'}` : ''} · ${accountRoles[u.role]} · ${u.status === 'active' ? '启用' : '停用'}`, children:
          u.role === 'employee' || (user.role === 'super_admin' && (u.role !== 'super_admin' || u.id === user.id))
            ? <AccountForm account={u} user={user} saved={u.id === user.id ? onSessionChanged : query.refresh} /> : <span className="muted">此账号由超级管理员管理。</span> })),
      ]} /></> },
    ]} />}</Load>
  </Card>;
}

function WorkForm({ work, users, currentUserId, shifts, saved }) {
  const [form] = Form.useForm();
  const roles = Form.useWatch('requiresRoles', form) ?? !!work?.requiresRoles;
  const fillAll = Form.useWatch('fillAllEnrolled', form) ?? !!work?.fillAllEnrolled;
  const { run, busy } = useAction();
  const people = users.map(u => ({ ...option(u.id, personLabel({ ...u, name: u.displayName ?? u.name }, currentUserId) + (u.status === 'active' ? '' : ' · 停用')), disabled: u.status !== 'active' }));
  const shiftOptions = shifts.map(s => ({ ...option(s.id, shiftText(s) + (s.active ? '' : ' · 停用')), disabled: !s.active }));
  const deputiesByPrimary = new Map();
  for (const { primaryUserId, deputyUserId } of work?.dutyPairs || []) {
    if (!deputiesByPrimary.has(primaryUserId)) deputiesByPrimary.set(primaryUserId, []);
    deputiesByPrimary.get(primaryUserId).push(deputyUserId);
  }
  const dutyGroups = [...deputiesByPrimary].map(([primaryUserId, deputyUserIds]) => ({ primaryUserId, deputyUserIds }));
  const initialValues = { name: '', description: '', color: '#4A90D9', sortOrder: 0, weekdays: [0], allowWeekdaySelection: false, fillAllEnrolled: false, defaultNeed: 1, requiresRoles: false, weeklyAssignments: [], active: true, ...work, dutyGroups };
  function save(values) {
    const body = {
      name: values.name.trim(), description: values.description?.trim() || '', color: typeof values.color === 'string' ? values.color : values.color.toHexString(),
      sortOrder: values.sortOrder, weekdays: values.weekdays || [], defaultNeed: values.defaultNeed, requiresRoles: values.requiresRoles,
      allowWeekdaySelection: values.allowWeekdaySelection, fillAllEnrolled: values.fillAllEnrolled,
      weeklyAssignments: (values.weeklyAssignments || []).map(a => ({ ...a, dutyRole: values.requiresRoles ? a.dutyRole === 'deputy' ? 'deputy' : 'primary' : 'member' })),
      dutyPairs: values.requiresRoles ? (values.dutyGroups || []).flatMap(({ primaryUserId, deputyUserIds }) =>
        deputyUserIds.map(deputyUserId => ({ primaryUserId, deputyUserId }))) : [],
    };
    return run(() => work ? API.updateWorkType(work.id, { ...body, active: values.active }) : API.createWorkType({ ...body, code: newCode('WT') }), '工作配置已保存', saved);
  }
  return <Form form={form} layout="vertical" initialValues={initialValues} disabled={busy} onFinish={save}>
    <Form.Item name="name" label="工作名称" rules={required}><Input maxLength={32} /></Form.Item>
    <Form.Item name="description" label="工作说明"><Input.TextArea rows={2} maxLength={200} /></Form.Item>
    <div className="form-grid">
      <Form.Item name="color" label="显示颜色"><ColorPicker disabledAlpha format="hex" showText /></Form.Item>
      <Form.Item name="sortOrder" label="显示排序" rules={required}><InputNumber min={0} max={999} precision={0} /></Form.Item>
    </div>
    <Form.Item name="requiresRoles" valuePropName="checked"><Checkbox onChange={e => { if (e.target.checked && form.getFieldValue('defaultNeed') === 1) form.setFieldValue('defaultNeed', 2); }}>区分主副负责人</Checkbox></Form.Item>
    {roles && <Form.List name="dutyGroups">{(fields, { add, remove }) => <div className="stack form-section">
      <Heading help="pairs">固定搭档轮值</Heading>
      {fields.map(({ key, name }) => <div className="choice" key={key}><div className="form-grid">
        <Form.Item name={[name, 'primaryUserId']} label="主负责人" rules={required}><Select showSearch optionFilterProp="label" options={people} /></Form.Item>
        <Form.Item name={[name, 'deputyUserIds']} label="副负责人" rules={[{ required: true, type: 'array', min: 1, message: '请选择至少一位副负责人' }]}>
          <Select mode="multiple" optionFilterProp="label" options={people} placeholder="可多选" />
        </Form.Item>
      </div><Button danger type="text" onClick={() => remove(name)}>移除此组</Button></div>)}
      <Button onClick={() => add()}>＋ 添加一组搭档</Button>
    </div>}</Form.List>}
    <Form.Item name="weekdays" label="每周需要哪些天"><Checkbox.Group options={days.map(d => option(d, weekdays[d]))} /></Form.Item>
    <Form.Item name="allowWeekdaySelection" valuePropName="checked"><Checkbox>允许自选报名星期</Checkbox></Form.Item>
    <Form.Item name="fillAllEnrolled" valuePropName="checked"><Checkbox>按报名安排</Checkbox></Form.Item>
    <Form.Item name="defaultNeed" label={fillAll ? '默认每班最低人数' : '默认每班人数'}
      extra={fillAll ? '报名且符合排班条件的人员都可安排。0 表示不安排。' : undefined}
      rules={[...required, { validator: (_, v) => roles && v === 1 ? Promise.reject(new Error('主副工作至少需要 2 人')) : Promise.resolve() }]}><InputNumber min={0} max={99} precision={0} /></Form.Item>
    <Form.List name="weeklyAssignments">{(fields, { add, remove }) => <div className="stack form-section">
      <Heading help="fixed">长期固定人员</Heading>
      {fields.map(({ key, name }) => <div className="choice" key={key}><div className="form-grid">
        <Form.Item name={[name, 'weekday']} label="星期" rules={required}><Select options={days.map(d => option(d, weekdays[d]))} /></Form.Item>
        <Form.Item name={[name, 'shiftId']} label="班次" rules={required}><Select options={shiftOptions} /></Form.Item>
        <Form.Item name={[name, 'userId']} label="人员" rules={required}><Select showSearch optionFilterProp="label" options={people} /></Form.Item>
        {roles && <Form.Item name={[name, 'dutyRole']} label="负责人角色" rules={[{ validator: (_, v) => ['primary', 'deputy'].includes(v) ? Promise.resolve() : Promise.reject(new Error('请选择主副角色')) }]}><Select options={roleOptions('primary', 'deputy')} /></Form.Item>}
      </div><Button danger type="text" onClick={() => remove(name)}>移除此人</Button></div>)}
      <Button onClick={() => add({ weekday: 1, dutyRole: roles ? 'primary' : 'member' })}>＋ 添加固定人员</Button>
    </div>}</Form.List>
    {work && <Form.Item name="active" valuePropName="checked"><Checkbox>启用工作</Checkbox></Form.Item>}
    <Button type="primary" htmlType="submit" loading={busy}>{work ? '保存工作设置' : '新增工作'}</Button>
  </Form>;
}

function ShiftForm({ shift, seq, saved }) {
  const { run, busy } = useAction();
  const initialValues = { ...shift, seq: shift?.seq || seq, active: shift?.active ?? true, startTime: dayjs('2000-01-01T' + (shift?.startTime || '08:00')), endTime: dayjs('2000-01-01T' + (shift?.endTime || '14:00')) };
  function save({ name, startTime, endTime, seq, active }) {
    return run(() => API.saveShift(shift?.id, { name: name.trim(), startTime: startTime.format('HH:mm'), endTime: endTime.format('HH:mm'), seq, ...(shift ? { active } : { code: newCode('SHIFT') }) }), '班次设置已保存', saved);
  }
  return <Form layout="vertical" initialValues={initialValues} disabled={busy} onFinish={save}>
    <Form.Item name="name" label="班次名称" rules={required}><Input maxLength={32} /></Form.Item>
    <div className="form-grid">{['startTime', 'endTime'].map((key, i) => <Form.Item key={key} name={key} label={i ? '结束时间' : '开始时间'} rules={required}><TimePicker format="HH:mm" /></Form.Item>)}</div>
    <Form.Item name="seq" label="班次顺序" rules={required}><InputNumber min={1} max={99} precision={0} /></Form.Item>
    {shift && <Form.Item name="active" valuePropName="checked"><Checkbox>启用班次</Checkbox></Form.Item>}
    <Button type="primary" htmlType="submit" loading={busy}>{shift ? '保存班次设置' : '新增班次'}</Button>
  </Form>;
}

function AccountForm({ account, user, saved }) {
  const { run, busy, confirm } = useAction();
  const initialValues = { role: 'employee', status: 'active', ...account };
  const superAccount = account?.role === 'super_admin';
  return <>
    <Form layout="vertical" initialValues={initialValues} disabled={busy} onFinish={v => run(() => API.saveUser(account?.id, v), '账号设置已保存', saved)}>
      <Form.Item name="employeeNo" label="登录账号（工号）" rules={[...required, { pattern: /^[a-zA-Z0-9_-]{2,32}$/, message: '请输入 2–32 位字母、数字、下划线或连字符' }]}><Input maxLength={32} autoComplete="username" /></Form.Item>
      <Form.Item name="name" label="姓名" rules={required}><Input maxLength={32} /></Form.Item>
      <Form.Item name="phone" label="手机号"><Input maxLength={32} inputMode="tel" /></Form.Item>
      {!superAccount && <Form.Item name="role" label="角色"><Select options={(user.role === 'super_admin' ? ['employee', 'admin'] : ['employee']).map(r => option(r, accountRoles[r]))} /></Form.Item>}
      {account && !superAccount && <Form.Item name="status" label="状态"><Select options={[option('active', '启用'), option('disabled', '停用')]} /></Form.Item>}
      {!account && <Form.Item name="password" label="初始密码" rules={inputPassword}><Input.Password maxLength={128} autoComplete="new-password" /></Form.Item>}
      <Button type="primary" htmlType="submit" loading={busy}>{account ? '保存账号设置' : '创建账号'}</Button>
    </Form>
    {account && <><Divider /><Form layout="vertical" disabled={busy} onFinish={async ({ newPassword }) => {
      if (await confirm('重置此账号密码？', '密码重置后，该账号需要重新登录。')) await run(() => API.resetUserPassword(account.id, newPassword), '密码已重置', saved);
    }}>
      <Form.Item name="newPassword" label="新密码" rules={inputPassword}><Input.Password maxLength={128} autoComplete="new-password" /></Form.Item>
      <Button htmlType="submit" loading={busy}>重置密码</Button>
    </Form></>}
  </>;
}
