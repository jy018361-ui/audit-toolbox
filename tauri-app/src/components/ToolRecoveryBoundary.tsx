import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  reportRecentRestoreRenderFailure,
  subscribeTaskRestore,
} from "../restore";

type Props = {
  toolId: string;
  toolName: string;
  children: ReactNode;
  onBackToHistory: () => void;
};

type State = { error: Error | null };

/**
 * 每个工具单独隔离。历史参数即使触发旧页面的渲染缺陷，也只替换当前工具
 * 内容，不会卸掉侧边栏、历史记录和整个应用外壳。
 */
export class ToolRecoveryBoundary extends Component<Props, State> {
  state: State = { error: null };
  private stopRestoreListener?: () => void;

  static getDerivedStateFromError(reason: unknown): State {
    return {
      error:
        reason instanceof Error
          ? reason
          : new Error("工具页面发生未知渲染错误。"),
    };
  }

  componentDidMount(): void {
    this.stopRestoreListener = subscribeTaskRestore((restore) => {
      // 出错后的工具子树已经卸载，新一次恢复包仍留在 pending 中；先解除
      // 边界，子页重新挂载后会自行消费，用户无需重启整个应用。
      if (restore.toolId === this.props.toolId && this.state.error) {
        this.setState({ error: null });
      }
    });
  }

  componentWillUnmount(): void {
    this.stopRestoreListener?.();
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRecentRestoreRenderFailure(this.props.toolId, error);
    console.error(`工具页面渲染失败：${this.props.toolId}`, error, info);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <section className="tool-recovery-card" role="alert">
        <p className="tool-recovery-eyebrow">页面已安全隔离</p>
        <h2>“{this.props.toolName}”未能恢复</h2>
        <p>
          历史任务参数可能来自较早版本，当前工具页加载时发生异常。应用其他功能仍可继续使用。
        </p>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={this.props.onBackToHistory}
          >
            返回历史记录
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => this.setState({ error: null })}
          >
            清空本页并重新打开
          </button>
        </div>
      </section>
    );
  }
}
