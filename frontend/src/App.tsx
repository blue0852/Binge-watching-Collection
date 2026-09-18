import { Routes, Route } from 'react-router-dom';
import Header from './components/Header.js';
import Home from './pages/Home.js';
import MovieDetail from './pages/MovieDetail.js';
import Sites from './pages/Sites.js';

export default function App() {
  return (
    <div className="app">
      <Header />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/movie/:id" element={<MovieDetail />} />
          <Route path="/sites" element={<Sites />} />
        </Routes>
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
  );
}
