// 桌面端置顶画中画窗口：独立渲染一个紧凑播放器，保留进度条与上下集
import { useState } from 'react';
import VideoPlayer from '../components/VideoPlayer.js';
import { getPipBridge, readPipSession } from './pip.js';

function closePip() {
  const bridge = getPipBridge();
  if (bridge) void bridge.close();
  else window.close();
}

export default function PipWindow() {
  const [session] = useState(() => readPipSession());

  if (!session) {
    return (
      <div className="pip-shell">
        <div className="pip-bar">
          <span className="pip-title">画中画</span>
          <button type="button" className="pip-close" onClick={closePip} title="关闭画中画">
            ✕
          </button>
        </div>
        <div className="pip-empty">没有可播放的内容，请回主窗口重新开启画中画</div>
      </div>
    );
  }

  return (
    <div className="pip-shell">
      <div className="pip-bar">
        <span className="pip-title" title={session.title}>
          {session.title}
        </span>
        <button type="button" className="pip-close" onClick={closePip} title="关闭画中画">
          ✕
        </button>
      </div>
      <div className="pip-body">
        <VideoPlayer
          files={session.files}
          poster={session.poster}
          title={session.title}
          sourceLabel={session.sourceLabel}
          historyMeta={session.historyMeta}
          compact
          pipMode
        />
      </div>
    </div>
  );
}
