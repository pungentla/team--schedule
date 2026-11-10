import React, { useEffect, useState } from 'react';
import Alert from 'antd/es/alert';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Empty from 'antd/es/empty';
import Form from 'antd/es/form';
import Popover from 'antd/es/popover';
import Spin from 'antd/es/spin';
import Tag from 'antd/es/tag';
import dayjs from 'dayjs';
import { API } from './api';
import { helpContent } from './help';

export const periodLabels = { draft: '未开放', enrolling: '报名中', scheduling: '排班中', published: '已发布', archived: '已归档' };
export const roleLabels = { member: '普通成员', primary: '主负责人', deputy: '副负责人', both: '主副皆可', either: '主/副额外名额' };
export const accountRoles = { employee: '员工', admin: '管理员', super_admin: '超级管理员' };
export const swapLabels = { pending: '待确认', approved: '已生效', rejected: '已拒绝', cancelled: '已撤回', expired: '已过期' };
export const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const option = (value, label) => ({ value, label });
export const personLabel = p => `${p.name}（${p.employeeNo}）`;
export const discussionName = (entry, anonymous = entry.anonymous) => anonymous
  ? entry.anonymousName || '匿名成员' : entry.authorName || '成员';
export const periodOptions = periods => periods.map(p => option(p.id, `${p.name}（${periodLabels[p.status]}）`));
export const roleOptions = (...roles) => roles.map(r => option(r, roleLabels[r]));
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const dateText = date => `${dayjs(date).format('MM月DD日')} ${weekdays[dayjs(date).day()]}`;
export const iso = date => date?.format('YYYY-MM-DD');
export const monthOf = date => date?.slice(0, 7);
export const shiftText = a => `${a.shiftName || a.name}${a.startTime && a.endTime ? ` · ${a.startTime}–${a.endTime}` : ''}`;
export const assignmentLabel = a => `${a.workDate} · ${shiftText(a)} · ${a.workTypeName}${a.dutyRole && a.dutyRole !== 'member' ? ` · ${roleLabels[a.dutyRole]}` : ''}`;
export const isAdmin = u => ['admin', 'super_admin'].includes(u?.role);
export const timeText = t => t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '—';
export const group = (items, key) => {
  const groups = new Map();
  for (const item of items) {
    const id = key(item);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  return [...groups];
};

export function useLoad(key, load, keepPrevious = false) {
  const [result, setResult] = useState({});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (key == null) return;
    let current = true;
    Promise.resolve().then(load).then(data => {
      if (current) setResult({ key, revision, data });
    }, error => {
      if (current) setResult({ key, revision, error });
    });
    return () => { current = false; };
  }, [key, revision]);
  const match = result.key === key && result.revision === revision;
  return { ...(match || (keepPrevious && result.key === key) ? result : {}), loading: key != null && !match, refresh: () => setRevision(n => n + 1) };
}
export function useAction() {
  const { message, modal } = App.useApp();
  const [busy, setBusy] = useState(false);
  async function run(action, success, onSuccess) {
    if (busy) return false;
    setBusy(true);
    try {
      const data = await action();
      if (success) message.success(typeof success === 'function' ? success(data) : success);
      onSuccess?.(data);
      return true;
    } catch (error) {
      const problems = error.details?.problems?.map(p => p.label || p.message || p.code).join('；');
      message.error(problems ? error.message + '：' + problems : error.message);
      return false;
    } finally { setBusy(false); }
  }
  function confirm(title, content, danger = false) {
    return new Promise(resolve => modal.confirm({ title, content, okText: '确认', cancelText: '取消', okButtonProps: { danger }, onOk: () => resolve(true), onCancel: () => resolve(false) }));
  }
  return { run, busy, confirm };
}
export function Load({ query, children, empty = '暂无数据' }) {
  if (query.loading && query.data === undefined) return <div className="loading"><Spin /></div>;
  if (query.error) return <Alert showIcon type="error" message={query.error.message} action={<Button onClick={query.refresh}>重试</Button>} />;
  return query.data == null ? <Empty description={empty} image={Empty.PRESENTED_IMAGE_SIMPLE} /> : children(query.data);
}
export const Blank = ({ children }) => <Empty description={children} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
export function Help({ name }) {
  const [title, copy] = helpContent[name] || [];
  if (!title) return null;
  return <Popover trigger="click" content={<div className="help-copy">{copy}</div>} title={title}><Button className="help-icon" type="text" shape="circle" aria-label={title + "说明"}>ⓘ</Button></Popover>;
}
export const Heading = ({ children, help }) => <h2 className="section-title">{children}{help && <Help name={help} />}</h2>;
export const Field = ({ label, children }) => <Form.Item label={label}>{children}</Form.Item>;
export const DutyTag = ({ role }) => role && role !== 'member' ? <Tag color="blue">{roleLabels[role]}</Tag> : null;
export const required = [{ required: true, message: '请填写此项' }];
export async function checkRemoval(context, enrollment, works, confirm) {
  if (context.period.status !== 'published') return true;
  const selected = new Set(works.map(w => w.workTypeId));
  const previous = [...(enrollment.submittedWorkTypeIds || []), ...(context.fixedAssignments || []).map(a => a.workTypeId)].filter(id => !(enrollment.withdrawnWorkTypeIds || []).includes(id));
  return !previous.some(id => !selected.has(id)) || confirm('取消部分工作报名？', '取消后，将移除明天起本周期内对应工作的已发布安排。', true);
}
export function savedEnrollment(result) {
  const c = result.scheduleChanges;
  return c ? `报名已提交 · 补入 ${c.addedCount} 项，移除 ${c.removedCount} 项` : '报名已提交';
}
export { API, dayjs };
