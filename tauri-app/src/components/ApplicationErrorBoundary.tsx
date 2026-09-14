import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean };

/** 最外层保险：任何未被工具级边界捕获的异常都不能留下无提示白屏。 */
export class ApplicationErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("应用界面渲染失败", error, info);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="application-recovery" role="alert">
        <h1>页面加载失败，但应用没有丢失</h1>
        <p>请重新加载界面；历史记录和本机文件不会因此被删除。</p>
        <button type="button" onClick={() => window.location.reload()}>
          重新加载应用
        </button>
      </main>
    );
  }
}
