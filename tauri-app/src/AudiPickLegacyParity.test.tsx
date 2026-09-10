// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AudiPickLegacyDashboard,
  type AudiPickLegacyProject,
} from "./AudiPickLegacyDashboard";
import {
  AudiPickLegacyProject as AudiPickLegacyProjectPage,
  type AudiPickLegacyProjectActions,
} from "./AudiPickLegacyProject";
import {
  AudiPickLegacyTemplates,
  type AudiPickLegacyTemplateActions,
} from "./AudiPickLegacyTemplates";
import {
  AudiPickLegacyContract,
  type AudiPickLegacyContractProps,
  type AudiPickLegacyContractView,
} from "./AudiPickLegacyContract";
import { AudiPickLegacyShell } from "./AudiPickLegacyShell";
import {
  AudiPickLegacyLoanAudit,
  buildAudiPickLoanAuditModel,
} from "./AudiPickLegacyLoanAudit";

const projectFixture: AudiPickLegacyProject = {
  id: "project-1",
  name: "华东收入审计",
  client: "示例客户",
  date: "2026-09-09",
  status: "active",
  createdAt: "2026-09-01T08:00:00+08:00",
  updatedAt: "2026-09-09T09:30:00+08:00",
  fileCount: 2,
  templateCount: 1,
  defaultTemplateName: "借款合同",
  progress: {
    phase: "复核中",
    tone: "blue",
    rootCount: 2,
    extracted: 1,
    reviewTotal: 1,
    reviewed: 0,
    percent: 50,
    ready: true,
  },
};

function projectActions(
  overrides: Partial<AudiPickLegacyProjectActions> = {},
): AudiPickLegacyProjectActions {
  return {
    onBack: vi.fn(),
    onBatchExtract: vi.fn(),
    onExportProject: vi.fn(),
    onPickPdfs: vi.fn(),
    onPickFolder: vi.fn(),
    onOpenDocument: vi.fn(),
    onDeleteDocument: vi.fn(),
    onRuleChange: vi.fn(),
    onConfirmRule: vi.fn(),
    onExtractDocument: vi.fn(),
    onViewWorkpaper: vi.fn(),
    onRemoveAssociation: vi.fn(),
    onConfirmAssociation: vi.fn(),
    ...overrides,
  };
}

function templateActions(
  overrides: Partial<AudiPickLegacyTemplateActions> = {},
): AudiPickLegacyTemplateActions {
  return {
    onCreateRule: vi.fn(),
    onCopyRule: vi.fn(),
    onSavePrompt: vi.fn(),
    onDeleteRule: vi.fn(),
    ...overrides,
  };
}

function contractProps(
  overrides: Partial<AudiPickLegacyContractProps> = {},
): AudiPickLegacyContractProps {
  return {
    view: "detail",
    projectName: "华东收入审计",
    contractName: "借款合同.pdf",
    clientName: "示例客户",
    projectDate: "2026-09-09",
    textLength: 1280,
    totalExtracted: 1,
    isScanned: false,
    aiReady: true,
    previewOpen: false,
    contractText: "这是合同正文。",
    fileFlow: {
      ruleId: "loan",
      rules: [{ id: "loan", name: "借款合同" }],
      ruleName: "借款合同",
      detectedLabel: "借款合同",
      detectedConfidence: "high",
      ruleConfirmed: true,
      resultCount: 1,
      appliedRuleCount: 1,
      onRuleChange: vi.fn(),
      onConfirmRule: vi.fn(),
      onExtract: vi.fn(),
      onExportCurrent: vi.fn(),
      onExportAll: vi.fn(),
    },
    workpaper: {
      ruleId: "loan",
      rules: [{ id: "loan", name: "借款合同" }],
      versions: [{ id: "v1", label: "首次提取", count: 1 }],
      versionId: "v1",
      filterText: "",
      columns: [{ key: "clause", label: "条款", editable: true }],
      rows: [{ id: "row-1", values: { clause: "借款金额100万元" } }],
      onRuleChange: vi.fn(),
      onVersionChange: vi.fn(),
      onFilterChange: vi.fn(),
      onSelectRow: vi.fn(),
      onFieldChange: vi.fn(),
      onSaveRow: vi.fn(),
      onCopyRow: vi.fn(),
      onToggleReviewed: vi.fn(),
      onOpenEvidence: vi.fn(),
    },
    onBackWorkbench: vi.fn(),
    onBackProject: vi.fn(),
    onViewChange: vi.fn(),
    onTogglePreview: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => window.setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AudiPick 1.4.6 界面回归", () => {
  it("工作台按便携版字段顺序打开弹窗，项目名和客户名均必填后提交", async () => {
    const onCreateProject = vi.fn();
    render(
      <AudiPickLegacyDashboard
        projects={[projectFixture]}
        templates={[{ id: "loan", name: "借款合同" }]}
        onCreateProject={onCreateProject}
        onContinueProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onProjectStatusChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    const dialog = screen.getByRole("dialog", { name: "新建项目" });
    const fields = Array.from(dialog.querySelectorAll("input, select"));
    expect(fields).toHaveLength(4);
    expect(fields[0]).toHaveAttribute("placeholder", "项目名称");
    expect(fields[1]).toHaveAttribute("placeholder", "客户名称");
    expect(fields[2].tagName).toBe("SELECT");
    expect(fields[3]).toHaveAttribute("aria-label", "项目日期");

    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请填写名称");
    expect(onCreateProject).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByPlaceholderText("项目名称"), {
      target: { value: "  新项目  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请填写名称");
    expect(onCreateProject).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByPlaceholderText("客户名称"), {
      target: { value: "  新客户  " },
    });
    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "loan" },
    });
    fireEvent.change(within(dialog).getByLabelText("项目日期"), {
      target: { value: "2026-10-01" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith({
        name: "新项目",
        client: "新客户",
        date: "2026-10-01",
        defaultTemplateId: "loan",
      }),
    );
  });

  it("工作台保留十二种排序，并回传筛选与项目状态变更", () => {
    const onPreferencesChange = vi.fn();
    const onProjectStatusChange = vi.fn();
    render(
      <AudiPickLegacyDashboard
        projects={[projectFixture]}
        templates={[]}
        onPreferencesChange={onPreferencesChange}
        onCreateProject={vi.fn()}
        onContinueProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onProjectStatusChange={onProjectStatusChange}
      />,
    );

    const sort = screen.getByRole("combobox", { name: "项目排序" });
    expect(within(sort).getAllByRole("option")).toHaveLength(12);
    fireEvent.change(sort, { target: { value: "progress_asc" } });
    expect(onPreferencesChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: "progress_asc" }),
    );

    fireEvent.change(screen.getByRole("combobox", { name: "项目状态筛选" }), {
      target: { value: "active" },
    });
    expect(onPreferencesChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "active" }),
    );

    fireEvent.change(screen.getByLabelText("项目状态"), {
      target: { value: "completed" },
    });
    expect(onProjectStatusChange).toHaveBeenCalledWith(
      projectFixture,
      "completed",
    );
  });

  it("项目页勾选待提取文件后执行批量提取回调", () => {
    const onBatchExtract = vi.fn();
    const actions = projectActions({ onBatchExtract });
    render(
      <AudiPickLegacyProjectPage
        project={{ id: "project-1", name: "华东收入审计" }}
        documents={[
          {
            id: "doc-1",
            name: "合同一.pdf",
            textLength: 800,
            resultCount: 0,
            ruleId: "loan",
          },
          {
            id: "doc-2",
            name: "合同二.pdf",
            textLength: 600,
            resultCount: 2,
            ruleId: "loan",
          },
        ]}
        rules={[{ id: "loan", name: "借款合同" }]}
        actions={actions}
      />,
    );

    const start = screen
      .getAllByRole("button", { name: "开始提取" })
      .find((button) => button.classList.contains("alp-button-primary"));
    expect(start).toBeDefined();
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择合同一.pdf" }));
    expect(start).toBeEnabled();
    fireEvent.click(start!);
    expect(onBatchExtract).toHaveBeenCalledWith(["doc-1"]);
  });

  it("模板库支持分类、搜索并回传模板选中", async () => {
    const onSelectRule = vi.fn();
    const onTabChange = vi.fn();
    const onSearchChange = vi.fn();
    render(
      <AudiPickLegacyTemplates
        rules={[
          {
            id: "loan",
            name: "借款合同模板",
            category: "loan",
            docKind: "contract",
            readonly: true,
            fields: [{ key: "amount", label: "借款金额" }],
          },
          {
            id: "invoice",
            name: "增值税发票模板",
            category: "voucher",
            docKind: "table",
            readonly: true,
            fields: [{ key: "tax", label: "税额" }],
          },
        ]}
        actions={templateActions({
          onSelectRule,
          onTabChange,
          onSearchChange,
        })}
      />,
    );

    expect(screen.getAllByRole("tab")).toHaveLength(5);
    fireEvent.click(screen.getByRole("tab", { name: "单据票证" }));
    expect(onTabChange).toHaveBeenCalledWith("voucher");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "增值税发票模板" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "借款合同模板" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索模板" }), {
      target: { value: "增值税" },
    });
    expect(onSearchChange).toHaveBeenCalledWith("增值税");
    fireEvent.click(screen.getByRole("button", { name: /增值税发票模板/ }));
    expect(onSelectRule).toHaveBeenCalledWith("invoice");
  });

  it("合同详情可以切换到工作底稿", () => {
    const onViewChange = vi.fn();

    function Harness() {
      const [view, setView] = useState<AudiPickLegacyContractView>("detail");
      return (
        <AudiPickLegacyContract
          {...contractProps({
            view,
            onViewChange: (next) => {
              onViewChange(next);
              setView(next);
            },
          })}
        />
      );
    }

    render(<Harness />);
    expect(screen.getByRole("heading", { name: "借款合同.pdf" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "工作底稿" }));
    expect(onViewChange).toHaveBeenCalledWith("workpaper");
    expect(screen.getByRole("heading", { name: "工作底稿" })).toBeInTheDocument();
    expect(screen.getAllByText("借款金额100万元")).toHaveLength(2);
  });

  it("侧栏处理工作日志只打开抽屉，不触发页面导航", () => {
    const onNavigate = vi.fn();
    const onToggleLog = vi.fn();
    render(
      <AudiPickLegacyShell
        activePage="workbench"
        configReady
        logCount={2}
        logOpen={false}
        themeLabel="经典蓝"
        onNavigate={onNavigate}
        onToggleLog={onToggleLog}
        onOpenTheme={vi.fn()}
        logDrawer={<div>处理日志内容</div>}
      >
        <div>当前工作台</div>
      </AudiPickLegacyShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: /处理工作日志/ }));
    expect(onToggleLog).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("借款审计中心按主合同形成债项并提供三种视图", () => {
    const input = {
      project: {
        id: "project-loan",
        name: "借款审计项目",
        client: "测试客户",
        date: "2026-12-31",
      },
      contracts: [
        {
          id: "contract-loan",
          name: "流动资金借款合同.pdf",
          ruleId: "loan_general",
        },
      ],
      results: [
        {
          id: "loan-row",
          contractId: "contract-loan",
          ruleId: "loan_general",
          contract_no: "JK-2026-001",
          borrower: "测试客户",
          lender: "示例银行",
          currency: "CNY",
          contract_principal: "1000000",
          signing_date: "2026-01-10",
          loan_start_date: "2026-01-15",
          maturity_date: "2027-01-14",
        },
      ],
      relationGroups: [],
      reportDate: "2026-12-31",
    };
    const model = buildAudiPickLoanAuditModel(input);
    expect(model.counts.debtCount).toBe(1);
    expect(model.debts[0]?.contractNo).toBe("JK-2026-001");

    render(
      <AudiPickLegacyLoanAudit
        {...input}
        actions={{
          onBack: vi.fn(),
          onReportDateChange: vi.fn(),
          onExport: vi.fn(),
          onOpenWorkpaper: vi.fn(),
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "借款审计中心" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "驾驶舱" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "合同卡片 · 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /还款计划/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "合同卡片 · 1" }));
    expect(
      screen.getByRole("heading", { name: "示例银行-JK-2026-001" }),
    ).toBeInTheDocument();
  });
});
