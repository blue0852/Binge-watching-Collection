import { useState, useEffect, useRef } from 'react';
import Hls from 'hls.js';
import type { PlayableFile } from '../types.js';

interface Props {
  files: PlayableFile[];
  poster?: string;
  title: string;
  sourceLabel?: string;
}

export default function VideoPlayer({ files, poster, title, sourceLabel }: Props) {
  const [current, setCurrent] = useState<PlayableFile | null>(null);
  const [error, setError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    if (files.length > 0) {
      const preferred =
        files.find((f) => f.format === 'm3u8' || f.url.includes('.m3u8')) ?? files[0];
      setCurrent(preferred);
      setError(false);
    }
  }, [files]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !current) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const isM3u8 =
      current.format === 'm3u8' ||
      current.url.includes('.m3u8') ||
      current.mimetype.includes('mpegurl');

    if (isM3u8 && Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(current.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError(true);
      });
    } else if (isM3u8 && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = current.url;
    } else {
      video.src = current.url;
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [current]);

  function switchFile(f: PlayableFile) {
    setCurrent(f);
    setError(false);
  }

  if (files.length === 0) {
    return (
      <div className="player player-empty">
        <p>⚠ 暂无可用播放地址</p>
        <p className="hint">该资源可能尚未更新或当前线路不可用，请尝试切换其他资源站</p>
      </div>
    );
  }

  return (
    <div className="player">
      <div className="player-video">
        {error ? (
          <div className="player-error">
            <p>⚠ 视频加载失败</p>
            <p className="hint">可能是网络问题或该线路暂时不可用，请尝试切换其他线路</p>
            <button className="btn" onClick={() => setError(false)}>
              重试
            </button>
          </div>
        ) : (
          current && (
            <video
              ref={videoRef}
              controls
              autoPlay
              playsInline
              poster={poster}
              preload="metadata"
              onError={() => setError(true)}
            >
              您的浏览器不支持 HTML5 视频播放。
            </video>
          )
        )}
      </div>
      {files.length > 1 && (
        <div className="player-sources">
          <span className="sources-label">选集 / 线路：</span>
          <div className="sources-list">
            {files.map((f) => (
              <button
                key={f.name + f.url}
                className={`source-btn ${current?.url === f.url ? 'active' : ''}`}
                onClick={() => switchFile(f)}
                title={f.name}
              >
                {shortLabel(f.name)}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="player-credit">
        正在播放「{title}」{sourceLabel ? ` · ${sourceLabel}` : ''}
      </p>
    </div>
  );
}

function shortLabel(name: string): string {
  const parts = name.split(' · ');
  return parts.length > 1 ? parts[parts.length - 1] : name;
}
