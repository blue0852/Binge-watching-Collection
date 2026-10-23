import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatBytes,
  getUpdaterBridge,
  readDismissedVersion,
  requestUpdateCheck,
  UPDATE_CHECK_EVENT,
  writeDismissedVersion,
  type UpdateState,
} from '../updater/updater.js';

/**
 * 更新提示条：固定在右下角，按状态切换文案与按钮。
 * - 安装版：可下载、显示进度、重启安装
 * - 便携版：只提示版本号并跳转下载页
 * 开发环境（mode=dev）完全不渲染。
 */
export default function UpdateBanner() {
  const bridgeRef = useRef(getUpdaterBridge());
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState<string>(readDismissedVersion);
  const [manualCheck, setManualCheck] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const bridge = bridgeRef.current;
    if (!bridge) return undefined;
    bridge
      .getState()
      .then((next) => {
        if (mountedRef.current) setState(next);
      })
      .catch(() => {});
    const off = bridge.onState((next) => {
      if (!mountedRef.current) return;
      setState(next);
      setHidden(false);
    });
    return () => {
      mountedRef.current = false;
      off();
    };
  }, []);

  const runCheck = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    setManualCheck(true);
    setHidden(false);
    try {
      const next = await bridge.check();
      if (mountedRef.current) setState(next);
    } catch {
      /* 主进程已把错误写进 state，这里忽略 IPC 异常 */
    }
  }, []);

  useEffect(() => {
    window.addEventListener(UPDATE_CHECK_EVENT, runCheck);
    return () => window.removeEventListener(UPDATE_CHECK_EVENT, runCheck);
  }, [runCheck]);

  const status = state?.status;
  useEffect(() => {
    if (status !== 'up-to-date') return undefined;
    const timer = window.setTimeout(() => {
      setHidden(true);
      setManualCheck(false);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

  if (!bridgeRef.current || !state || state.mode === 'dev' || hidden) return null;

  const latest = state.latestVersion || '';
  const dismissedForCurrent = latest !== '' && dismissed === latest;
  const visible = (() => {
    switch (state.status) {
      case 'checking':
      case 'up-to-date':
        return manualCheck;
      case 'available':
      case 'downloaded':
        return !dismissedForCurrent;
      case 'downloading':
      case 'error':
        return true;
      default:
        return false;
    }
  })();
  if (!visible) return null;

  function dismiss() {
    const key = latest;
    if (key) {
      writeDismissedVersion(key);
      setDismissed(key);
    }
    setManualCheck(false);
    setHidden(true);
  }

  async function withBusy(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const auto = state.mode === 'auto';
  const title = (() => {
    switch (state.status) {
      case 'checking':
        return '正在检查更新…';
      case 'up-to-date':
        return '已是最新版本';
      case 'available':
        return latest ? `发现新版本 ${latest}` : '发现新版本';
      case 'downloading':
        return latest ? `正在下载 ${latest}` : '正在下载更新';
      case 'downloaded':
        return '更新已就绪';
      case 'error':
        return '更新检查失败';
      default:
        return '';
    }
  })();

  return (
    <div className={`update-toast update-toast-${state.status}`} role="status" aria-live="polite">
      <div className="update-toast-head">
        <span className="update-toast-dot" aria-hidden="true" />
        <strong className="update-toast-title">{title}</strong>
        {(state.status === 'available' ||
          state.status === 'downloaded' ||
          state.status === 'error') && (
          <button type="button" className="update-toast-close" onClick={dismiss} aria-label="关闭">
            ×
          </button>
        )}
      </div>

      <p className="update-toast-text">
        {state.status === 'available' && !auto
          ? `当前 ${state.currentVersion}，便携版需要手动下载安装包。`
          : state.status === 'available'
            ? `当前 ${state.currentVersion}，可下载后在后台安装。`
            : state.status === 'downloaded'
              ? '重启应用即可完成安装，播放进度不会丢失。'
              : state.status === 'downloading'
                ? `${formatBytes(state.transferred)} / ${formatBytes(state.total)} · ${formatBytes(
                    state.bytesPerSecond,
                  )}/s`
                : state.status === 'up-to-date'
                  ? `当前版本 ${state.currentVersion}`
                  : state.message}
      </p>

      {state.status === 'downloading' && (
        <div
          className="update-progress"
          role="progressbar"
          aria-valuenow={Math.round(state.percent)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className="update-progress-bar" style={{ width: `${Math.min(100, state.percent)}%` }} />
        </div>
      )}

      <div className="update-toast-actions">
        {state.status === 'available' && auto && (
          <>
            <button
              type="button"
              className="update-btn update-btn-primary"
              disabled={busy}
              onClick={() => void withBusy(() => bridgeRef.current!.download())}
            >
              下载更新
            </button>
            <button type="button" className="update-btn" onClick={dismiss}>
              稍后
            </button>
          </>
        )}
        {state.status === 'available' && !auto && (
          <>
            <button
              type="button"
              className="update-btn update-btn-primary"
              disabled={busy}
              onClick={() => void withBusy(() => bridgeRef.current!.openReleases())}
            >
              前往下载
            </button>
            <button type="button" className="update-btn" onClick={dismiss}>
              稍后
            </button>
          </>
        )}
        {state.status === 'downloaded' && (
          <>
            <button
              type="button"
              className="update-btn update-btn-primary"
              disabled={busy}
              onClick={() => void withBusy(() => bridgeRef.current!.install())}
            >
              立即重启安装
            </button>
            <button type="button" className="update-btn" onClick={dismiss}>
              稍后
            </button>
          </>
        )}
        {state.status === 'error' && (
          <button
            type="button"
            className="update-btn"
            disabled={busy}
            onClick={() => void withBusy(() => runCheck())}
          >
            重试
          </button>
        )}
      </div>
    </div>
  );
}

/** 页脚版本号 + 手动检查入口 */
export function UpdateFooterLink() {
  const [info, setInfo] = useState<{ version: string; mode: string } | null>(null);

  useEffect(() => {
    const bridge = getUpdaterBridge();
    if (!bridge) return;
    bridge
      .getState()
      .then((s) => setInfo({ version: s.currentVersion, mode: s.mode }))
      .catch(() => {});
  }, []);

  if (!info || info.mode === 'dev') return null;

  return (
    <button type="button" className="footer-update-link" onClick={requestUpdateCheck}>
      v{info.version} · 检查更新
    </button>
  );
}
