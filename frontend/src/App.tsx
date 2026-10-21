import { lazy, Suspense } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import Header from './components/Header.js';
import Home from './pages/Home.js';
import ErrorBoundary from './components/ErrorBoundary.js';
import { PlayerProvider } from './player/PlayerProvider.js';

// 详情页会把 hls.js 一起带进来，首页用不到，按需加载
const MovieDetail = lazy(() => import('./pages/MovieDetail.js'));
const Sites = lazy(() => import('./pages/Sites.js'));
const History = lazy(() => import('./pages/History.js'));

function PageFallback() {
  return (
    <div className="loading">
      <div className="spinner" />
      <p>正在加载…</p>
    </div>
  );
}

function NotFound() {
  return (
    <div className="empty">
      <p>页面不存在</p>
      <p className="hint" style={{ marginTop: 8 }}>
        <Link to="/">返回首页</Link>
      </p>
    </div>
  );
}

export default function App() {
  return (
    <PlayerProvider>
      <div className="app">
        <Header />
        <main className="main">
          <ErrorBoundary>
            <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/movie/:id" element={<MovieDetail />} />
                <Route path="/sites" element={<Sites />} />
                <Route path="/history" element={<History />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
        <footer className="footer">
          <p>
            数据来源 ·{' '}
            <a href="https://archive.org" target="_blank" rel="noopener noreferrer">
              Internet Archive
            </a>{' '}
            · config.json 配置的 VOD 资源站 · 仅供学习研究
          </p>
        </footer>
      </div>
    </PlayerProvider>
  );
}
