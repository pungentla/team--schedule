import React, { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Alert from 'antd/es/alert';
import App from 'antd/es/app';
import Badge from 'antd/es/badge';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import ConfigProvider from 'antd/es/config-provider';
import Dropdown from 'antd/es/dropdown';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Spin from 'antd/es/spin';
import zhCN from 'antd/es/locale/zh_CN';
import BellOutlined from '@ant-design/icons/es/icons/BellOutlined';
import 'dayjs/locale/zh-cn';
import 'antd/dist/reset.css';
import { API, Heading, Load, accountRoles, dayjs, isAdmin, required, useAction, useLoad } from './shared';
import { Schedule, readScheduleFilters, saveScheduleFilters } from './Schedule';
import { Announcement } from './Announcement';
import { DiscussionPreview } from './DiscussionPreview';
import { ReminderSettings, logoutDevice, restoreDeviceReminder } from './ReminderSettings';
import './style.css';

dayjs.locale('zh-cn');
const Settings = lazy(() => import('./Settings').then(m => ({ default: m.Settings })));
const Workflow = lazy(() => import('./Workflow').then(m => ({ default: m.Workflow })));
const Swaps = lazy(() => import('./Swaps').then(m => ({ default: m.Swaps })));
const Enrollment = lazy(() => import('./Enrollment').then(m => ({ default: m.Enrollment })));
const Discussions = lazy(() => import('./Discussions'));
const replyNotificationKey = 'new-discussion-reply';

const theme = {
  token: { colorPrimary: '#2e59ae', colorBgLayout: '#f2f5f9', colorText: '#1f2a3c', colorTextSecondary: '#58677e', borderRadius: 10, controlHeight: 42, fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif' },
  components: { Card: { bodyPadding: 16, headerPadding: 16 }, Form: { itemMarginBottom: 14 } },
};

function Root() {
  const [user, setUser] = useState(() => API.getToken() ? API.getUser() : null);
  const { message } = App.useApp();
  function clearSession() { API.clearSession(); setUser(null); }
  useEffect(() => {
    let active = true;
    const token = API.getToken();
    const expired = () => { if (active) setUser(null); };
    window.addEventListener('teamshift:session-expired', expired);
    if (token) API.me().then(me => {
      if (active && API.getToken() === token) { API.setSession(token, me); setUser(me); }
    }).catch(e => { if (active && e.status !== 401) message.error(e.message); });
    return () => { active = false; window.removeEventListener('teamshift:session-expired', expired); };
  }, []);
  return user ? <Workspace key={user.id} user={user} endSession={clearSession} /> : <Login loggedIn={({ token, user }) => { API.setSession(token, user); setUser(user); }} />;
}

function Login({ loggedIn }) {
  const { run, busy } = useAction();
  return <main className="login"><Card className="login-card">
    <h1>时禾</h1>
    <p className="muted">取意于《传道书》3:2 的「栽种有时」，寓意顺时耕耘，一起成长。</p>
    <Form layout="vertical" requiredMark={false} disabled={busy} onFinish={({ employeeNo, password }) => run(() => API.login(employeeNo.trim(), password), null, loggedIn)}>
      <Form.Item name="employeeNo" label="账号 / 工号" rules={required}><Input autoComplete="username" maxLength={32} placeholder="输入工号" /></Form.Item>
      <Form.Item name="password" label="密码" rules={required}><Input.Password autoComplete="current-password" maxLength={128} placeholder="输入密码" /></Form.Item>
      <Button block type="primary" htmlType="submit" loading={busy}>登录</Button>
    </Form>
  </Card></main>;
}

function readNotificationTarget() {
  const params = new URLSearchParams(window.location.search);
  const topic = Number(params.get('topic'));
  const swap = Number(params.get('swap'));
  const notice = Number(params.get('notice'));
  if (Number.isSafeInteger(topic) && topic > 0) return { tab: 'discussions', topic };
  if (Number.isSafeInteger(swap) && swap > 0) return { tab: 'swaps', swap };
  return { tab: 'schedule', notice: Number.isSafeInteger(notice) && notice > 0 ? notice : null };
}

function Workspace({ user, endSession }) {
  const [notificationTarget, setNotificationTarget] = useState(readNotificationTarget);
  const [tab, setTab] = useState(notificationTarget.tab);
  const [settingsTab, setSettingsTab] = useState('worktypes');
  const [workflowPage, setWorkflowPage] = useState(null);
  const [discussionTopicId, setDiscussionTopicId] = useState(notificationTarget.topic ?? null);
  const [discussionOpenVersion, setDiscussionOpenVersion] = useState(0);
  const [password, setPassword] = useState(false);
  const [reminders, setReminders] = useState(false);
  const [scheduleFilters, setScheduleFilters] = useState(() => readScheduleFilters(user.id));
  useEffect(() => saveScheduleFilters(user.id, scheduleFilters), [user.id, scheduleFilters]);
  useEffect(() => { restoreDeviceReminder(user.id).catch(() => {}); }, [user.id]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!['topic', 'swap', 'notice'].some(key => url.searchParams.has(key))) return;
    for (const key of ['topic', 'swap', 'notice']) url.searchParams.delete(key);
    window.history.replaceState(null, '', url);
  }, []);
  const updateScheduleFilters = changes => setScheduleFilters(previous => ({ ...previous, ...changes }));
  const dirty = useRef(false);
  const { confirm, busy, run } = useAction();
  const { message } = App.useApp();
  const periodsQuery = useLoad('periods', () => Promise.all([API.listPeriods(), API.currentPeriod()]), true);
  const unreadQuery = useLoad(user.id, API.unreadTopicReplies, true);
  const hotTopicsQuery = useLoad(tab === 'schedule' || tab === 'discussions' ? 'hot-topics' : null,
    () => API.discussionTopics(1, { sort: 'hot', pageSize: 3 }), true);
  const hotTopicRanks = new Map(hotTopicsQuery.data?.items
    .filter(topic => topic.likeCount + topic.replyCount > 0)
    .map((topic, index) => [topic.id, index + 1]));
  const refreshUnread = useEffectEvent(() => unreadQuery.refresh());
  useEffect(() => {
    const refreshVisible = () => { if (!document.hidden) refreshUnread(); };
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    const timer = window.setInterval(refreshVisible, 30000);
    return () => {
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.clearInterval(timer);
    };
  }, []);
  const unreadTopics = unreadQuery.data ?? [];
  const unreadCounts = new Map(unreadTopics.map(topic => [topic.id, topic.unreadCount]));
  const [periods, current] = periodsQuery.data || [[], null];
  const period = periods.find(p => p.id === scheduleFilters.periodId) || current || periods.find(p => p.status !== 'archived') || periods[0];
  const tabs = [
    ['schedule', '工作台'], ['discussions', '互动区'], ['enrollment', '我的报名'], ['swaps', '我的换班'],
    ...(isAdmin(user) ? [['workflow', '安排排班']] : []),
  ];
  const activeNav = tab === 'settings' ? 'workflow' : tab;
  async function navigate(next) {
    if (next === tab) return true;
    if (dirty.current && !await confirm('放弃未保存的需求？')) return false;
    dirty.current = false;
    setNotificationTarget({});
    if (next === 'workflow' && tab !== 'settings') setWorkflowPage(null);
    setTab(next);
    window.scrollTo(0, 0);
    if (['workflow','enrollment'].includes(next)) periodsQuery.refresh();
    return true;
  }
  async function openSettings(section = settingsTab) {
    if (await navigate('settings')) setSettingsTab(section);
  }
  async function openDiscussions(topicId = null) {
    if (await navigate('discussions')) {
      setDiscussionTopicId(topicId);
      if (topicId === discussionTopicId && topicId != null) setDiscussionOpenVersion(version => version + 1);
      unreadQuery.refresh();
    }
  }
  async function logout() {
    if (!await confirm('确认退出登录？', dirty.current ? '未保存的需求会丢失。' : '退出后需重新登录。')) return;
    await run(() => logoutDevice(user.id), null, endSession);
  }
  function sessionChanged() {
    endSession(); message.success('请使用更新后的账号重新登录');
  }
  return <div className="workspace">
    <div className="workspace-top">
      <header className="topbar"><div className="topbar-inner">
        <div className="brand-lockup"><span className="brand">时禾</span><span className="brand-caption">传3:2 栽种有时</span></div>
        <div className="account-actions">
          <ReplyNotifications query={unreadQuery} open={openDiscussions} />
          <Dropdown trigger={['click']} menu={{ items: [
            { key: 'reminders', label: '消息提醒' }, { key: 'password', label: '修改密码' },
          ], onClick: ({ key }) => key === 'reminders' ? setReminders(true) : setPassword(true) }}>
            <Button type="text" className="account-menu" title={`${user.name}（${user.employeeNo}）`}>{user.name}{isAdmin(user) && user.name !== accountRoles[user.role] && ` · ${accountRoles[user.role]}`} ▾</Button>
          </Dropdown>
          <Button ghost loading={busy} onClick={logout}>退出</Button>
        </div>
      </div></header>
      {(tab === 'schedule' || tab === 'discussions') && <div className="announcement-area">
        <Announcement key={tab} user={user} initialId={notificationTarget.notice} />
      </div>}
    </div>
    <main className="content stack">
      {tab === 'schedule' && <DiscussionPreview openDiscussions={openDiscussions} hotTopicsQuery={hotTopicsQuery} hotTopicRanks={hotTopicRanks} />}
      {isAdmin(user) && (tab === 'workflow' || tab === 'settings') && <Alert type="info" showIcon message="仅管理员可见" />}
      <Suspense fallback={<div className="loading"><Spin /></div>}>
        {tab === 'schedule' && <Schedule user={user} periods={periods} period={period} filters={scheduleFilters} updateFilters={updateScheduleFilters} />}
        {tab === 'enrollment' && <Load query={periodsQuery}>{() => <Enrollment periods={periods} period={period} />}</Load>}
        {tab === 'swaps' && <Swaps user={user} initialDetail={notificationTarget.swap} />}
        {tab === 'discussions' && <Discussions topicId={discussionTopicId} openVersion={discussionOpenVersion} open={openDiscussions}
          unreadCounts={unreadCounts} refreshUnread={unreadQuery.refresh}
          hotTopicRanks={hotTopicRanks} refreshHotTopics={hotTopicsQuery.refresh}
          back={() => setDiscussionTopicId(null)} />}
        {tab === 'workflow' && isAdmin(user) && <Load query={periodsQuery}>{() => (
          <Workflow user={user} periods={periods} page={workflowPage} setPage={setWorkflowPage}
            refreshPeriods={periodsQuery.refresh} openSettings={openSettings} dirty={dirty} />
        )}</Load>}
        {tab === 'settings' && isAdmin(user) && <Settings user={user} tab={settingsTab} setTab={setSettingsTab}
          back={() => navigate('workflow')} onSessionChanged={sessionChanged} />}
      </Suspense>
    </main>
    <nav className="bottom-nav" aria-label="主导航"><div className="bottom-nav-inner">
      {tabs.map(([id, label]) => <Button key={id} type="text" aria-current={activeNav === id ? 'page' : undefined}
        onClick={() => id === 'discussions' ? openDiscussions() : navigate(id)}>{label}</Button>)}
    </div></nav>
    {password && <Password close={() => setPassword(false)} saved={endSession} />}
    {reminders && <ReminderSettings close={() => setReminders(false)} />}
  </div>;
}

function ReplyNotifications({ query, open }) {
  const { notification } = App.useApp();
  const seenThrough = useRef(null);
  const openTopic = useRef(open);
  useEffect(() => { openTopic.current = open; }, [open]);
  useEffect(() => () => notification.destroy(replyNotificationKey), [notification]);
  useEffect(() => {
    if (!query.data) return;
    const latest = query.data[0];
    const previous = seenThrough.current;
    seenThrough.current = Math.max(previous ?? 0, latest?.latestReplyId ?? 0);
    if (previous == null || !latest || latest.latestReplyId <= previous) return;
    notification.open({ key: replyNotificationKey, message: '收到话题回复', duration: 5, placement: 'bottomRight',
      description: <div className="reply-notification-copy">
        <strong>{latest.title}</strong><p>{latest.excerpt}</p>
        <Button type="link" onClick={() => { notification.destroy(replyNotificationKey); openTopic.current(latest.id); }}>查看话题</Button>
      </div>,
    });
  }, [query.data, notification]);
  const topics = query.data ?? [];
  const total = topics.reduce((sum, topic) => sum + topic.unreadCount, 0);
  const label = `话题回复，${total} 条未读`;
  const button = <Button ghost className="reply-notification-button" aria-label={label} title={label}
    icon={<Badge count={total} size="small" overflowCount={999}><BellOutlined /></Badge>} />;
  const items = topics.length ? topics.map(topic => ({ key: String(topic.id), label: <div className="reply-notification-copy">
    <div className="reply-notification-item"><span>{topic.title}</span><small className="muted">{topic.unreadCount} 条未读</small></div>
    <p className="muted">{topic.excerpt}</p>
  </div> })) : [query.error ? { key: 'retry', label: '提醒加载失败，点击重试' }
    : { key: 'empty', label: query.loading ? '正在加载' : '暂无未读话题回复', disabled: true }];
  return <Dropdown trigger={['click']} onOpenChange={visible => { if (visible) notification.destroy(replyNotificationKey); }}
    menu={{ items, className: 'reply-notification-menu',
    onClick: ({ key }) => key === 'retry' ? query.refresh() : open(Number(key)) }}>{button}</Dropdown>;
}

function Password({ close, saved }) {
  const { run, busy } = useAction();
  return <Modal open title="修改密码" onCancel={() => !busy && close()} footer={null}>
    <Form layout="vertical" disabled={busy} onFinish={({ oldPassword, newPassword }) => run(() => API.changePassword({ oldPassword, newPassword }), '密码已修改，请重新登录', saved)}>
      <Form.Item name="oldPassword" label="当前密码" rules={required}><Input.Password autoComplete="current-password" maxLength={128} /></Form.Item>
      <Form.Item name="newPassword" label="新密码" dependencies={['oldPassword']} rules={[
        { required: true, min: 6, max: 128, message: '新密码需为 6–128 位' },
        ({ getFieldValue }) => ({ validator: (_, v) => !v || v !== getFieldValue('oldPassword') ? Promise.resolve() : Promise.reject(new Error('新密码不能与原密码相同')) }),
      ]}><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item>
      <Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[
        ...required, ({ getFieldValue }) => ({ validator: (_, v) => !v || v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次新密码不一致')) }),
      ]}><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item>
      <Button type="primary" htmlType="submit" loading={busy}>保存新密码</Button>
    </Form>
  </Modal>;
}

createRoot(document.getElementById('root')).render(
  <ConfigProvider locale={zhCN} theme={theme} button={{ autoInsertSpace: false }}><App notification={{ bottom: 68 }}><Root /></App></ConfigProvider>
);
