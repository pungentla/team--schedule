import React, { useEffect, useRef } from 'react';
import Alert from 'antd/es/alert';
import App from 'antd/es/app';
import Badge from 'antd/es/badge';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Spin from 'antd/es/spin';
import BellOutlined from '@ant-design/icons/es/icons/BellOutlined';
import RightOutlined from '@ant-design/icons/es/icons/RightOutlined';
import { Blank, assignmentLabel } from './shared';

const replyNotificationKey = 'new-discussion-reply';
const discussionNoticeLabels = {
  topic_comment: '你的话题有新评论',
  topic_reply: '你的话题有新回复',
  direct_reply: '有人回复了你',
  discussion_reply: '参与的话题有新回复',
};

export function MessageBell({ inboxes, active, open, openTopic }) {
  const { notification } = App.useApp();
  const seenThrough = useRef(null);
  const latestOpen = useRef(openTopic);
  const topics = inboxes.topics.data;
  useEffect(() => { latestOpen.current = openTopic; }, [openTopic]);
  useEffect(() => () => notification.destroy(replyNotificationKey), [notification]);
  useEffect(() => {
    if (active) notification.destroy(replyNotificationKey);
    if (!topics) return;
    const latest = topics[0];
    const previous = seenThrough.current;
    seenThrough.current = Math.max(previous ?? 0, latest?.latestReplyId ?? 0);
    if (active || previous == null || !latest || latest.latestReplyId <= previous) return;
    notification.open({ key: replyNotificationKey, message: discussionNoticeLabels[latest.kind] ?? '收到话题回复', duration: 5, placement: 'bottomRight',
      description: <div className="reply-notification-copy">
        <strong>{latest.title}</strong><p>{latest.excerpt}</p>
        <Button type="link" onClick={() => { notification.destroy(replyNotificationKey); latestOpen.current(latest.id, latest.latestReplyId); }}>查看回复</Button>
      </div>,
    });
  }, [active, topics, notification]);

  const total = [...(topics ?? []), ...(inboxes.likes.data ?? [])]
    .reduce((sum, topic) => sum + topic.unreadCount, (inboxes.swaps.data?.length ?? 0) + (inboxes.system.data?.length ?? 0));
  const label = `消息提醒，${total} 条`;
  return <Button ghost className="reply-notification-button" aria-label={label} title={label} aria-current={active ? 'page' : undefined}
    onClick={open} icon={<Badge count={total} size="small" overflowCount={999}><BellOutlined /></Badge>} />;
}

function MessageRow({ title, meta, description, excerpt, open }) {
  return <li><button type="button" className="message-row" onClick={open}>
    <span className="message-copy">
      <span className="message-row-heading"><strong>{title}</strong>{meta && <small className="muted">{meta}</small>}</span>
      {description && <span className="muted">{description}</span>}
      {excerpt && <span className="muted">{excerpt}</span>}
    </span>
    <RightOutlined className="message-chevron" aria-hidden="true" />
  </button></li>;
}

export function Messages({ inboxes, back, openTopic, openSwap, openSystemNotice }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const sources = Object.values(inboxes);
  const errors = sources.filter(inbox => inbox.error);
  const loading = sources.some(inbox => inbox.loading);
  const { system, topics, likes, swaps } = inboxes;
  const groups = [
    ['系统消息', system.data, notice => {
      const isTopic = notice.kind === 'new_topics';
      const isProxy = notice.kind === 'proxy_enrollment';
      const title = isTopic ? '互动区有新话题了' : isProxy ? `${notice.actorName || '管理员'}帮你代报名了` : `「${notice.periodName}」正在报名`;
      const action = isTopic ? '查看话题' : isProxy ? '查看报名' : '参与报名';
      return <MessageRow key={notice.id} title={title}
        description={isProxy ? `${notice.periodName} · ${action}` : action} open={() => openSystemNotice(notice)} />;
    }],
    ['话题互动', topics.data, topic => <MessageRow key={topic.id} title={topic.title} meta={`${topic.unreadCount} 条未读`}
      description={discussionNoticeLabels[topic.kind] ?? '话题有新回复'} excerpt={topic.excerpt}
      open={() => openTopic(topic.id, topic.latestReplyId)} />],
    ['话题点赞', likes.data, topic => <MessageRow key={topic.id} title={topic.title} meta={`${topic.unreadCount} 个新赞`}
      description="你的话题收到了点赞" open={() => openTopic(topic.id)} />],
    ['换班申请', swaps.data, swap => <MessageRow key={swap.id} title={`${swap.requesterName}发起的换班`} meta="待确认"
      description={swap.fromAssign && assignmentLabel(swap.fromAssign)} open={() => openSwap(swap.id)} />],
  ].filter(([, entries]) => entries?.length);

  return <>
    <div className="message-page-heading">
      <Button type="link" onClick={back}>← 返回</Button>
      <h1 ref={heading} tabIndex={-1}>消息提醒</h1>
    </div>
    {errors.length > 0 && <Alert type="error" showIcon message="部分消息加载失败"
      action={<Button size="small" onClick={() => errors.forEach(inbox => inbox.refresh())}>重试</Button>} />}
    {groups.map(([title, entries, render]) => <Card key={title} title={title} className="message-group">
      <ul aria-label={title}>{entries.map(render)}</ul>
    </Card>)}
    {!groups.length && (loading ? <div className="loading" role="status"><Spin aria-label="正在加载消息" /></div>
      : !errors.length && <Blank>暂无消息提醒</Blank>)}
  </>;
}
