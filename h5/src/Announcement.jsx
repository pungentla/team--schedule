import React, { useId, useState } from 'react';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Tag from 'antd/es/tag';
import { API, isAdmin, timeText, useAction, usePageLoad } from './shared';

export function Announcement({ user, initialId = null }) {
  const query = usePageLoad('announcements', API.announcements, true);
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const [reading, setReading] = useState(initialId);
  const [editing, setEditing] = useState(null);
  const { run, busy, confirm } = useAction();
  const canPublish = isAdmin(user);
  const announcements = query.data ?? [];
  const latest = announcements[0];
  const announcement = announcements.find(item => item.id === reading);
  if (!announcements.length && !canPublish && !query.error) return null;

  async function withdraw() {
    if (!await confirm('撤下这条公告？')) return;
    await run(() => API.withdrawAnnouncement(announcement.id), '公告已撤下', () => {
      setReading(null);
      query.refresh();
    });
  }

  return <Card size="small" className="announcement-card">
    <section aria-label="公告栏">
      <div className="announcement-row">
        <Tag>公告</Tag>
        {latest
          ? <Button type="link" className="announcement-title" onClick={() => setReading(latest.id)}>{latest.title}</Button>
          : <span className="muted">{query.error ? '公告加载失败' : query.loading ? '正在加载' : '暂无公告'}</span>}
        {query.error && <Button type="link" onClick={query.refresh}>重试</Button>}
        {canPublish && !query.error && <Button size="small" disabled={query.loading} onClick={() => setEditing({})}>发布公告</Button>}
        {announcements.length > 1 && <Button type="link" size="small" className="announcement-toggle"
          aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
          {expanded ? '收起' : `展开（${announcements.length}）`}
        </Button>}
      </div>
      {announcements.length > 1 && <ul id={listId} className="announcement-list" hidden={!expanded}>
        {expanded && announcements.slice(1).map(item => <li key={item.id}>
          <Button type="link" className="announcement-title" onClick={() => setReading(item.id)}>{item.title}</Button>
        </li>)}
      </ul>}
    </section>
    {announcement && <Modal open title={<span className="announcement-heading">{announcement.title}</span>}
      onCancel={() => !busy && setReading(null)} footer={canPublish ? <div className="inline">
        <Button onClick={() => { setEditing(announcement); setReading(null); }} disabled={busy}>编辑</Button>
        <Button danger onClick={withdraw} loading={busy}>撤下</Button>
      </div> : null}>
      <div className="muted">{[announcement.publisherName, timeText(announcement.publishedAt)].filter(Boolean).join(' · ')}</div>
      <p className="announcement-content">{announcement.content}</p>
    </Modal>}
    {editing && <PublishAnnouncement announcement={editing} close={() => setEditing(null)} saved={() => { setEditing(null); query.refresh(); }} />}
  </Card>;
}

function PublishAnnouncement({ announcement, close, saved }) {
  const { run, busy } = useAction();
  const editing = !!announcement.id;
  return <Modal open title={editing ? '编辑公告' : '发布公告'} onCancel={() => !busy && close()} footer={null}>
    <Form layout="vertical" disabled={busy} initialValues={announcement} onFinish={values => run(
      () => editing ? API.updateAnnouncement(announcement.id, values) : API.publishAnnouncement(values), editing ? '公告已更新' : '公告已发布', saved)}>
      <Form.Item name="title" label="公告标题" rules={[{ required: true, whitespace: true, message: '请输入公告标题' }]}>
        <Input maxLength={60} />
      </Form.Item>
      <Form.Item name="content" label="公告正文" rules={[{ required: true, whitespace: true, message: '请输入公告正文' }]}>
        <Input.TextArea rows={4} maxLength={2000} showCount />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={busy}>{editing ? '保存' : '确认发布'}</Button>
    </Form>
  </Modal>;
}
