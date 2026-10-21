import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** 顶层错误边界：单个页面渲染异常不再导致整屏白页 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] 渲染异常', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-box" role="alert">
        <p>页面出现异常：{error.message}</p>
        <p className="hint" style={{ marginTop: 8 }}>
          可以返回首页重试；如果反复出现，请通过顶部「刷新」清理缓存。
        </p>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
            重试
          </button>
          <a className="btn" href="/">
            返回首页
          </a>
        </div>
      </div>
    );
  }
}
