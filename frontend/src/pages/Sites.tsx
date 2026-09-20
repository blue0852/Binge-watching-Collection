import { useState, useEffect, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { addVodSite, deleteVodSite, fetchVodSites } from '../api/client.js';
import type { VodSiteEntry } from '../types.js';

const emptyForm = (): VodSiteEntry => ({
  key: '',
  name: '',
  api: '',
  detail: '',
});

export default function SitesPage() {
  const [sites, setSites] = useState<VodSiteEntry[]>([]);
  const [form, setForm] = useState<VodSiteEntry>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);

  function loadSites() {
    setLoading(true);
    setError(null);
    fetchVodSites()
      .then((res) => {
        setSites(res.sites);
        if (res.configPath) setConfigPath(res.configPath);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadSites();
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    setError(null);
    setSubmitting(true);
    addVodSite({
      key: form.key.trim(),
      name: form.name.trim(),
      api: form.api.trim(),
      detail: form.detail?.trim() || undefined,
    })
      .then((res) => {
        setSites(res.sites);
        if (res.configPath) setConfigPath(res.configPath);
        setForm(emptyForm());
        setMessage('站点已添加并写入 config.json');
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSubmitting(false));
  }

  function onDelete(site: VodSiteEntry) {
    const ok = window.confirm(`确定删除站点「${site.name}」（${site.key}）？此操作会修改 config.json。`);
    if (!ok) return;
    setMessage(null);
    setError(null);
    setDeletingKey(site.key);
    deleteVodSite(site.key)
      .then((res) => {
        setSites(res.sites);
        if (res.configPath) setConfigPath(res.configPath);
        setMessage(`已删除「${site.name}」`);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setDeletingKey(null));
  }

  return (
    <div className="sites-page">
      <div className="sites-back">
        <Link to="/">← 返回首页</Link>
      </div>
      <h1 className="sites-title">VOD 站点管理</h1>
      <p className="sites-desc hint">
        在此添加或删除 MacCMS 风格资源站，变更会立即写入{' '}
        {configPath ? (
          <code>{configPath}</code>
        ) : (
          <code>config.json</code>
        )}
        。Internet Archive 为内置数据源，不在此列表中。
      </p>

      {error && <div className="error-box sites-flash">{error}</div>}
      {message && <div className="sites-success sites-flash">{message}</div>}

      <section className="sites-panel">
        <h2>添加站点</h2>
        <form className="sites-form" onSubmit={onSubmit}>
          <label>
            <span>Key（英文标识）</span>
            <input
              type="text"
              required
              pattern="[A-Za-z0-9_-]{1,64}"
              title="字母、数字、下划线、连字符，1–64 位"
              placeholder="例如 myzy"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
          </label>
          <label>
            <span>显示名称</span>
            <input
              type="text"
              required
              placeholder="例如 某某资源"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="sites-form-wide">
            <span>API 地址</span>
            <input
              type="url"
              required
              placeholder="https://example.com/api.php/provide/vod"
              value={form.api}
              onChange={(e) => setForm({ ...form, api: e.target.value })}
            />
          </label>
          <label className="sites-form-wide">
            <span>Detail（可选）</span>
            <input
              type="url"
              placeholder="https://example.com"
              value={form.detail ?? ''}
              onChange={(e) => setForm({ ...form, detail: e.target.value })}
            />
          </label>
          <div className="sites-form-actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? '保存中…' : '添加站点'}
            </button>
          </div>
        </form>
      </section>

      <section className="sites-panel">
        <h2>已配置站点（{sites.length}）</h2>
        {loading ? (
          <div className="loading">
            <div className="spinner" />
            <p>加载中…</p>
          </div>
        ) : sites.length === 0 ? (
          <p className="hint">暂无 VOD 站点，请添加或检查 config.json。</p>
        ) : (
          <ul className="sites-list">
            {sites.map((site) => (
              <li key={site.key} className="sites-list-item">
                <div className="sites-list-main">
                  <strong>{site.name}</strong>
                  <span className="sites-list-key">{site.key}</span>
                  <a href={site.api} target="_blank" rel="noopener noreferrer" className="sites-list-api">
                    {site.api}
                  </a>
                  {site.detail && (
                    <span className="hint sites-list-detail">detail: {site.detail}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={deletingKey === site.key}
                  onClick={() => onDelete(site)}
                >
                  {deletingKey === site.key ? '删除中…' : '删除'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
