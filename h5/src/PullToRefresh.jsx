import React, { createContext, useContext, useEffect, useEffectEvent, useRef, useState } from 'react';
import App from 'antd/es/app';
import Spin from 'antd/es/spin';

const RefreshContext = createContext(null);
const triggerDistance = 72;

export function usePullRefresh(refresh, enabled = true) {
  const callbacks = useContext(RefreshContext);
  const refreshLatest = useEffectEvent(refresh);
  useEffect(() => {
    if (!callbacks || !enabled) return;
    const callback = () => refreshLatest();
    callbacks.add(callback);
    return () => { callbacks.delete(callback); };
  }, [callbacks, enabled]);
}

export function PullToRefresh({ children, canRefresh }) {
  const { message } = App.useApp();
  const [callbacks] = useState(() => new Set());
  const [indicator, setIndicator] = useState(null);
  const surface = useRef(null);
  const refreshing = useRef(false);
  const refresh = useEffectEvent(async () => {
    if (refreshing.current || !callbacks.size) return;
    if (!canRefresh()) {
      message.warning('请先保存当前编辑，再刷新');
      return;
    }
    refreshing.current = true;
    const top = surface.current.querySelector('.workspace-top')?.getBoundingClientRect().bottom ?? 0;
    setIndicator({ top, loading: true, offset: 12 });
    try {
      const results = await Promise.allSettled([...callbacks].map(callback => Promise.resolve().then(callback)));
      if (results.some(result => result.status === 'rejected' || result.value === false)) {
        message.error('部分内容刷新失败，请重试');
      }
    } finally {
      refreshing.current = false;
      setIndicator(null);
    }
  });

  useEffect(() => {
    const element = surface.current;
    let gesture = null;

    function start(event) {
      if (event.touches.length !== 1) {
        cancel();
        return;
      }
      if (refreshing.current || window.scrollY > 0 || !callbacks.size) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable], .workspace-top, .bottom-nav')) return;
      for (let parent = target; parent && parent !== element; parent = parent.parentElement) {
        if (parent.scrollTop > 0 || (parent.scrollHeight > parent.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(parent).overflowY))) return;
      }
      const touch = event.touches[0];
      const top = element.querySelector('.workspace-top')?.getBoundingClientRect().bottom ?? 0;
      gesture = { x: touch.clientX, y: touch.clientY, top, distance: 0 };
    }

    function move(event) {
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dy = touch.clientY - gesture.y;
      const dx = Math.abs(touch.clientX - gesture.x);
      if (dy < -6 || (dx > 8 && dx >= dy) || window.scrollY > 0) {
        cancel();
        return;
      }
      if (dy <= 6 && !gesture.distance) return;
      if (event.cancelable) event.preventDefault();
      gesture.distance = Math.max(0, dy);
      setIndicator({ top: gesture.top, ready: dy >= triggerDistance, offset: Math.min(12, gesture.distance / 6) });
    }

    function cancel() {
      gesture = null;
      if (!refreshing.current) setIndicator(null);
    }

    function end() {
      if (!gesture) return;
      const { distance } = gesture;
      cancel();
      if (distance >= triggerDistance) void refresh();
    }

    element.addEventListener('touchstart', start, { passive: true });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', cancel);
    return () => {
      element.removeEventListener('touchstart', start);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', cancel);
    };
  }, [callbacks]);

  return <RefreshContext.Provider value={callbacks}>
    <div className="pull-refresh-surface" ref={surface}>
      {children}
      {indicator && <div className="pull-refresh-indicator" role="status" style={{ top: indicator.top + indicator.offset }}>
        {indicator.loading && <Spin size="small" />}
        {indicator.loading ? '正在刷新' : indicator.ready ? '松开刷新' : '下拉刷新'}
      </div>}
    </div>
  </RefreshContext.Provider>;
}
