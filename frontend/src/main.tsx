import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';
import PipWindow from './pip/PipWindow.js';
import './styles.css';

// 桌面端置顶画中画窗口复用同一份构建产物，用 ?pip=1 区分
const isPipWindow = new URLSearchParams(window.location.search).get('pip') === '1';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isPipWindow ? (
      <PipWindow />
    ) : (
      <BrowserRouter>
        <App />
      </BrowserRouter>
    )}
  </React.StrictMode>,
);
