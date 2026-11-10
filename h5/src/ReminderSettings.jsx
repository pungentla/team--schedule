import React from 'react';
import Button from 'antd/es/button';
import Modal from 'antd/es/modal';
import { API, Load, useAction, useLoad } from './shared';

const reminderOwnerKey = 'teamshift_pending_reminder_owner';

async function currentDeviceSubscription() {
  if (window.isSecureContext && navigator.serviceWorker) {
    const registration = await navigator.serviceWorker.getRegistration().catch(() => null);
    return registration?.pushManager?.getSubscription().catch(() => null);
  }
  return null;
}

export async function logoutDevice(userId) {
  const subscription = await currentDeviceSubscription();
  const result = await API.logout(subscription?.endpoint);
  if (result.deviceReminderWasEnabled) localStorage.setItem(reminderOwnerKey, String(userId));
}

export async function restoreDeviceReminder(userId) {
  const owner = String(userId);
  if (localStorage.getItem(reminderOwnerKey) !== owner || window.Notification?.permission !== 'granted') return;
  const token = API.getToken();
  const subscription = await currentDeviceSubscription();
  if (!subscription || !token || API.getToken() !== token || localStorage.getItem(reminderOwnerKey) !== owner) return;
  await API.enableReminder(subscription.toJSON());
  if (API.getToken() === token && localStorage.getItem(reminderOwnerKey) === owner) localStorage.removeItem(reminderOwnerKey);
}

async function disableDeviceReminder(subscription) {
  await API.disableReminder(subscription.endpoint);
  localStorage.removeItem(reminderOwnerKey);
  await subscription.unsubscribe().catch(() => {});
}

export function ReminderSettings({ close }) {
  const { run, busy } = useAction();
  const query = useLoad('device-reminders', async () => {
    if (!window.isSecureContext) return { unavailable: '请通过 HTTPS 打开时禾，再开启消息提醒。' };
    if (!('PushManager' in window) || !('Notification' in window) || !navigator.serviceWorker) {
      return { unavailable: 'iPhone 或 iPad 请从 Safari 将时禾添加到主屏幕，再从图标打开。其他设备请使用支持网页通知的浏览器。' };
    }
    await navigator.serviceWorker.register('/push-worker.js');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return { registration, subscription, ...await API.reminderStatus(subscription?.endpoint) };
  });

  function enable({ registration, subscription, publicKey }) {
    return run(async () => {
      const applicationServerKey = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
      try { subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }); }
      catch (error) {
        if (error.name === 'NotAllowedError') throw new Error('请在设备设置中允许时禾发送通知。');
        throw error;
      }
      await API.enableReminder(subscription.toJSON());
      localStorage.removeItem(reminderOwnerKey);
    }, '已开启本机提醒', query.refresh);
  }

  function test(subscription) {
    return run(async () => {
      try { return await API.testReminder(subscription.endpoint); }
      catch (error) {
        if (error.status === 404) {
          await subscription.unsubscribe().catch(() => {});
          query.refresh();
        }
        throw error;
      }
    }, '测试通知已发送');
  }

  return <Modal open title="消息提醒" onCancel={() => !busy && close()} footer={null}>
    <div className="stack">
      <p>接收话题互动、换班和新公告提醒。次日有排班时，前一天 18:00（北京时间）也会提醒你。</p>
      <Load query={query}>{data => {
        if (data.unavailable || !data.publicKey) return <p className="muted">{data.unavailable || '服务器尚未开启推送。'}</p>;
        return <>
          <p className="muted">{data.enabled ? '本机提醒已开启' : '本机提醒未开启'}</p>
          {Notification.permission === 'denied' && <p className="muted">请在设备设置中允许时禾发送通知。</p>}
          <div className="inline">
            {data.enabled ? <>
              <Button type="primary" disabled={busy || Notification.permission === 'denied'} onClick={() => test(data.subscription)}>发送测试通知</Button>
              <Button disabled={busy} onClick={() => run(() => disableDeviceReminder(data.subscription), '已关闭本机提醒', query.refresh)}>关闭本机提醒</Button>
            </> : <Button type="primary" disabled={busy || Notification.permission === 'denied'} onClick={() => enable(data)}>开启本机提醒</Button>}
          </div>
        </>;
      }}</Load>
    </div>
  </Modal>;
}
