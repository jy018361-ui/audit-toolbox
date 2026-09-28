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
import { filterCovenantRows, filterCovenantScope, type CovenantScopeFilter, type ProcedureFilter } from "./audipickCovenant";
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
  it("契约结果只显示明确后果和规范分类，不显示待核实诊断行", () => {
    const base = contractProps({ view: "workpaper" });
    const onExportCurrent = vi.fn();
    const onExportFiltered = vi.fn();
    const onProcedureLevelChange = vi.fn();
    const rows = [
      { id: "one", covenant_scope: "repayment", covenant_category: "财务指标及资本金", title: "财务指标及资本金", excerpt: "资产负债率不得超过70%。", breach_consequence: "贷款人有权要求提前还款。", pages: "1" },
      { id: "two", covenant_scope: "supplementary", covenant_category: "担保及融资限制", title: "对外担保限制", excerpt: "未经贷款人书面同意不得新增对外担保。", breach_consequence: "违反后计收违约金。", pages: "2" },
      { id: "warning", covenant_scope: "unresolved", title: "待补页码", excerpt: "专款专用。", breach_consequence: "关联后果待核实。", pages: "" },
    ];
    function Harness() {
      const [level, setLevel] = useState<ProcedureFilter>("all");
      const [scope, setScope] = useState<CovenantScopeFilter>("repayment");
      const [selected, setSelected] = useState("one");
      const scoped = filterCovenantScope(rows, scope);
      const filtered = filterCovenantRows(scoped, level, false);
      return <AudiPickLegacyContract {...base} fileFlow={{ ...base.fileFlow, onExportCurrent }} workpaper={{ ...base.workpaper, ruleId: "loan_covenant", rules: [{ id: "loan_covenant", name: "限制性契约" }], totalCount: 2, selectedRowId: selected, columns: [{ key: "covenant_category", label: "分类" }, { key: "title", label: "标题摘要", editable: true }, { key: "excerpt", label: "原文摘录", editable: true, long: true }, { key: "breach_consequence", label: "违反约定的后果", editable: true, long: true }, { key: "pages", label: "页码", editable: true }], rows: filtered.map((values) => ({ id: values.id, values })), covenantScopeFilter: scope, covenantScopeCounts: { repayment: 1, supplementary: 1 }, onCovenantScopeChange: setScope, procedureFilter: level, onProcedureFilterChange: setLevel, onSelectRow: setSelected, onProcedureLevelChange, onExportFiltered }} />;
    }
    render(<Harness />);
    expect(screen.getByText("1 / 2 条结果")).toBeInTheDocument();
    expect(screen.getAllByText("财务指标及资本金")).not.toHaveLength(0);
    expect(screen.queryByText("对外担保限制")).not.toBeInTheDocument();
    expect(screen.queryByText("待补页码")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /关联待核实/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("筛选契约结果范围"), { target: { value: "supplementary" } });
    expect(screen.getAllByText("对外担保限制")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "导出当前底稿" }));
    expect(onExportCurrent).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("筛选程序建议等级"), { target: { value: "1" } });
    expect(screen.getByText("1 / 2 条结果")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出筛选结果（1条）" }));
    expect(onExportFiltered).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("调整程序建议等级"), { target: { value: "2" } });
    expect(onProcedureLevelChange).toHaveBeenCalledWith("two", "2");
  });

  it("未关联诊断同时显示原始失败记录数和归并后的问题组数", () => {
    const base = contractProps({ view: "workpaper" });
    render(<AudiPickLegacyContract {...base} workpaper={{
      ...base.workpaper,
      ruleId: "loan_covenant",
      rules: [{ id: "loan_covenant", name: "限制性契约" }],
      rows: [],
      totalCount: 0,
      covenantDiagnostics: [
        { id: "a", clause: "第二十三条第（二）项第8目", reason: "义务证据仅为标题", evidence: "证据A", rejected: "", count: 5 },
        { id: "b", clause: "第二十一条第（六）项", reason: "后果落在其他条款", evidence: "证据B", rejected: "", count: 2 },
      ],
    }} />);
    expect(screen.getByText("关联未完成：7 条失败记录，归并为 2 组待核实")).toBeInTheDocument();
    expect(screen.getByText(/第二十三条第（二）项第8目：义务证据仅为标题（重复 5 条）/)).toBeInTheDocument();
    expect(screen.getByText(/不是已发生的违约/)).toBeInTheDocument();
  });

  it("非限制性契约底稿不出现新增分级控件", () => {
    render(<AudiPickLegacyContract {...contractProps({ view: "workpaper" })} />);
    expect(screen.queryByLabelText("筛选程序建议等级")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("调整程序建议等级")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("借款金额100万元")).toBeInTheDocument();
  });

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

  it("项目页按文件名自然排序并按显示顺序批量提取", () => {
    const onBatchExtract = vi.fn();
    render(
      <AudiPickLegacyProjectPage
        project={{ id: "project-1", name: "批量合同审阅" }}
        documents={[
          { id: "doc-10", name: "C10合同.pdf", textLength: 800, resultCount: 0, ruleId: "loan" },
          { id: "doc-2", name: "C2合同.pdf", textLength: 800, resultCount: 0, ruleId: "loan" },
          { id: "doc-1", name: "C1合同.pdf", textLength: 800, resultCount: 0, ruleId: "loan" },
        ]}
        rules={[{ id: "loan", name: "借款合同" }]}
        actions={projectActions({ onBatchExtract })}
      />,
    );

    expect(
      screen
        .getAllByRole("button", { name: /^C\d+合同\.pdf$/ })
        .map((button) => button.textContent),
    ).toEqual(["C1合同.pdf", "C2合同.pdf", "C10合同.pdf"]);

    fireEvent.click(screen.getByRole("checkbox", { name: "全选待提取" }));
    const start = screen
      .getAllByRole("button", { name: "开始提取" })
      .find((button) => button.classList.contains("alp-button-primary"));
    fireEvent.click(start!);
    expect(onBatchExtract).toHaveBeenCalledWith(["doc-1", "doc-2", "doc-10"]);
  });
  it("关联子项按名称自然排序且 AI 建议资料只显示一次", () => {
    render(
      <AudiPickLegacyProjectPage
        project={{ id: "project-1", name: "关联合同审阅" }}
        documents={[
          { id: "anchor", name: "C1主合同.pdf", textLength: 800, ruleId: "loan" },
          { id: "child-10", name: "C10补充协议.pdf", textLength: 500, ruleId: "loan" },
          { id: "suggested", name: "C3补充资料.pdf", textLength: 500, ruleId: "loan" },
          { id: "child-2", name: "C2补充协议.pdf", textLength: 500, ruleId: "loan" },
        ]}
        rules={[{ id: "loan", name: "借款合同" }]}
        relationGroups={[{
          id: "group-1",
          anchorFileId: "anchor",
          members: [
            { fileId: "child-10", role: "补充协议/变更" },
            { fileId: "child-2", role: "补充协议/变更" },
          ],
        }]}
        associationSuggestions={[{
          fileId: "suggested",
          anchorFileId: "anchor",
          anchorName: "C1主合同.pdf",
          role: "其他支持资料",
          reason: "文件名与主合同编号一致",
        }]}
        actions={projectActions()}
      />,
    );

    expect(screen.getAllByRole("button", { name: "C3补充资料.pdf" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /已关联 2 份/ }));
    expect(
      Array.from(document.querySelectorAll(".alp-child-name .alp-truncate")).map(
        (element) => element.textContent,
      ),
    ).toEqual(["C2补充协议.pdf", "C10补充协议.pdf"]);
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
    const onBackToToolbox = vi.fn();
    const onToggleLog = vi.fn();
    render(
      <AudiPickLegacyShell
        activePage="workbench"
        configReady
        logCount={2}
        logOpen={false}
        onNavigate={onNavigate}
        onBackToToolbox={onBackToToolbox}
        onToggleLog={onToggleLog}
        logDrawer={<div>处理日志内容</div>}
      >
        <div>当前工作台</div>
      </AudiPickLegacyShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: /处理工作日志/ }));
    expect(onToggleLog).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "返回工具箱" }));
    expect(onBackToToolbox).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /主题设置/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新手引导/ })).not.toBeInTheDocument();
    expect(screen.getByText("AI 已配置")).toBeInTheDocument();
    expect(screen.getByText("项目与审阅数据仅存本地")).toBeInTheDocument();
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
