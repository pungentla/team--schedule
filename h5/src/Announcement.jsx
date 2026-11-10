import React, { useState } from 'react';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Tag from 'antd/es/tag';
import { API, isAdmin, timeText, useAction, useLoad } from './shared';

export function Announcement({ user }) {
  const query = useLoad('announcement', API.announcement, true);
  const [reading, setReading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const canPublish = isAdmin(user);
  const announcement = query.data;
  if (!announcement && !canPublish && !query.error) return null;

  return <Card size="small" className="announcement-card">
    <section className="announcement-row" aria-label="公告栏">
      <Tag>公告</Tag>
      {announcement ? <Button type="link" className="announcement-title" onClick={() => setReading(true)}>{announcement.title}</Button>
        : <span className="muted announcement-status">{query.error ? '公告加载失败' : query.loading ? '正在加载' : '暂无公告'}</span>}
      {query.error && <Button type="link" onClick={query.refresh}>重试</Button>}
      {canPublish && !query.error && <Button disabled={query.loading} onClick={() => setPublishing(true)}>发布公告</Button>}
    </section>
    {reading && announcement && <Modal open title={<span className="announcement-heading">{announcement.title}</span>} onCancel={() => setReading(false)} footer={null}>
      <div className="muted">{[announcement.publisherName, timeText(announcement.publishedAt)].filter(Boolean).join(' · ')}</div>
      <p className="announcement-content">{announcement.content}</p>
    </Modal>}
    {publishing && <PublishAnnouncement close={() => setPublishing(false)} saved={() => { setPublishing(false); query.refresh(); }} />}
  </Card>;
}

function PublishAnnouncement({ close, saved }) {
  const { run, busy } = useAction();
  return <Modal open title="发布公告" onCancel={() => !busy && close()} footer={null}>
    <Form layout="vertical" disabled={busy} onFinish={values => run(() => API.publishAnnouncement(values), '公告已发布', saved)}>
      <p className="muted announcement-hint">新公告会替换公告栏中的当前公告。</p>
      <Form.Item name="title" label="公告标题" rules={[{ required: true, whitespace: true, message: '请输入公告标题' }]}>
        <Input maxLength={60} />
      </Form.Item>
      <Form.Item name="content" label="公告正文" rules={[{ required: true, whitespace: true, message: '请输入公告正文' }]}>
        <Input.TextArea rows={4} maxLength={2000} showCount />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={busy}>确认发布</Button>
    </Form>
  </Modal>;
}
