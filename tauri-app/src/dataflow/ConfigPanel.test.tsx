// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { ConfigPanel } from "./ConfigPanel";
import { defaultConfigFor, type DataflowNode } from "./model";

// db_in 表下拉的数据源：mock 掉 ../api，按用例给成功/失败实现。
const { dbTablesMock } = vi.hoisted(() => ({ dbTablesMock: vi.fn() }));
vi.mock("../api", () => ({ dataflowDbTables: dbTablesMock }));

beforeEach(() => {
  dbTablesMock.mockReset();
});

afterEach(() => {
  cleanup();
});

/** 静态渲染：适合单步交互断言（表单不随 onConfigChange 更新）。 */
function renderPanel(type: string, config: Record<string, unknown> = defaultConfigFor(type)) {
  const onConfigChange = vi.fn();
  const node: DataflowNode = { id: "n1", type, name: "节点", x: 0, y: 0, config };
  render(
    <ConfigPanel
      node={node}
      params={[]}
      collapsed={false}
      onToggleCollapse={() => undefined}
      onRename={() => undefined}
      onConfigChange={onConfigChange}
      onDelete={() => undefined}
      onPickPath={() => undefined}
    />,
  );
  return { onConfigChange };
}

/** 状态化渲染：onConfigChange 直接回灌组件，模拟页面真实联动（多步编辑用）。 */
function renderLivePanel(type: string, initial: Record<string, unknown> = defaultConfigFor(type)) {
  const onConfigChange = vi.fn();
  function Harness() {
    const [config, setConfig] = useState<Record<string, unknown>>(initial);
    return (
      <ConfigPanel
        node={{ id: "n1", type, name: "节点", x: 0, y: 0, config }}
        params={[]}
        collapsed={false}
        onToggleCollapse={() => undefined}
        onRename={() => undefined}
        onConfigChange={(next) => {
          onConfigChange(next);
          setConfig(next);
        }}
        onDelete={() => undefined}
        onPickPath={() => undefined}
      />
    );
  }
  render(<Harness />);
  return { onConfigChange };
}

describe("数据流配置区：检查规则编辑器（增删改）", () => {
  it("初始无规则给出提示；按所选类型添加规则", () => {
    const { onConfigChange } = renderPanel("check_n");
    expect(screen.getByText(/尚未配置规则/)).toBeInTheDocument();
    // 底部「新增规则类型」下拉默认借贷平衡，切到「唯一」后添加。
    fireEvent.change(screen.getByDisplayValue("借贷平衡"), { target: { value: "unique" } });
    fireEvent.click(screen.getByRole("button", { name: "添加规则" }));
    expect(onConfigChange).toHaveBeenLastCalledWith({
      rules: [{ type: "unique", field: "", groupBy: [] }],
    });
  });

  it("修改借贷平衡规则：分组、借贷字段、容差（支持小数）", () => {
    const { onConfigChange } = renderLivePanel("check_n", {
      rules: [{ type: "balance", groupBy: [], debitField: "", creditField: "", tolerance: 0 }],
    });
    fireEvent.change(screen.getByPlaceholderText("分组字段（留空＝全表），如 凭证号"), {
      target: { value: "凭证号" },
    });
    fireEvent.change(screen.getByPlaceholderText("借方金额字段"), { target: { value: "借方金额" } });
    fireEvent.change(screen.getByPlaceholderText("贷方金额字段"), { target: { value: "贷方金额" } });
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.01" } });
    expect(onConfigChange).toHaveBeenLastCalledWith({
      rules: [
        {
          type: "balance",
          groupBy: ["凭证号"],
          debitField: "借方金额",
          creditField: "贷方金额",
          tolerance: 0.01,
        },
      ],
    });
  });

  it("区间规则的上下限可留空（null）并回填数字", () => {
    const { onConfigChange } = renderLivePanel("check_n", {
      rules: [{ type: "range", field: "金额", min: null, max: null }],
    });
    const limits = screen.getAllByPlaceholderText(/限（/);
    expect(limits).toHaveLength(2);
    fireEvent.change(limits[0], { target: { value: "0" } });
    fireEvent.change(limits[1], { target: { value: "100" } });
    expect(onConfigChange).toHaveBeenLastCalledWith({
      rules: [{ type: "range", field: "金额", min: 0, max: 100 }],
    });
  });

  it("切换规则类型＝整条重建；删除规则从列表移除", () => {
    const { onConfigChange } = renderLivePanel("check_n", {
      rules: [{ type: "expression", expression: "金额 > 0" }],
    });
    // 规则行内的类型下拉当前显示「表达式」。
    fireEvent.change(screen.getByDisplayValue("表达式"), { target: { value: "range" } });
    expect(onConfigChange).toHaveBeenLastCalledWith({
      rules: [{ type: "range", field: "", min: null, max: null }],
    });
    fireEvent.click(screen.getByRole("button", { name: "删除此行" }));
    expect(onConfigChange).toHaveBeenLastCalledWith({ rules: [] });
  });
});

describe("数据流配置区：手工输入内嵌小表", () => {
  it("顶部提示小表随流程文件保存；加列补齐单元格、加行按列数生成", () => {
    const { onConfigChange } = renderLivePanel("manual_in");
    expect(screen.getByText("小表随流程文件保存，分享时会一并发出。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加列" }));
    expect(onConfigChange).toHaveBeenLastCalledWith({
      columns: [
        { name: "列名", type: "text" },
        { name: "列名", type: "text" },
      ],
      rows: [["", ""]],
      onRowError: "stop",
    });

    fireEvent.click(screen.getByRole("button", { name: "添加行" }));
    expect(onConfigChange).toHaveBeenLastCalledWith({
      columns: [
        { name: "列名", type: "text" },
        { name: "列名", type: "text" },
      ],
      rows: [
        ["", ""],
        ["", ""],
      ],
      onRowError: "stop",
    });
  });

  it("编辑单元格与列名/列类型存入 config", () => {
    const { onConfigChange } = renderLivePanel("manual_in", {
      columns: [
        { name: "科目编码", type: "text" },
        { name: "金额", type: "decimal" },
      ],
      rows: [["1002", "1250"]],
      onRowError: "stop",
    });
    fireEvent.change(screen.getByLabelText("单元格 1 行 1 列（科目编码）"), {
      target: { value: "100201" },
    });
    // 两列的列名输入框同占位符，取第一列（科目编码）改名。
    fireEvent.change(screen.getAllByPlaceholderText("列名")[0], { target: { value: "科目代码" } });
    fireEvent.change(screen.getByDisplayValue("十进制小数"), { target: { value: "date" } });
    expect(onConfigChange).toHaveBeenLastCalledWith({
      columns: [
        { name: "科目代码", type: "text" },
        { name: "金额", type: "date" },
      ],
      rows: [["100201", "1250"]],
      onRowError: "stop",
    });
  });

  it("删除列时行内单元格同步裁齐；仅剩一列时禁删列、仍可删行", () => {
    const { onConfigChange } = renderLivePanel("manual_in", {
      columns: [
        { name: "科目编码", type: "text" },
        { name: "金额", type: "decimal" },
      ],
      rows: [["1002", "1250"]],
      onRowError: "stop",
    });
    // 列定义区在前、数据行区在后（DOM 顺序），第一个「删除此行」删的是第一列。
    fireEvent.click(screen.getAllByRole("button", { name: "删除此行" })[0]);
    expect(onConfigChange).toHaveBeenLastCalledWith({
      columns: [{ name: "金额", type: "decimal" }],
      rows: [["1250"]],
      onRowError: "stop",
    });
    // 只剩一列后删列禁用，但删行可用。
    const after = screen.getAllByRole("button", { name: "删除此行" });
    expect(after[0]).toBeDisabled();
    fireEvent.click(after[1]);
    expect(onConfigChange).toHaveBeenLastCalledWith({
      columns: [{ name: "金额", type: "decimal" }],
      rows: [],
      onRowError: "stop",
    });
  });
});

describe("数据流配置区：db_in 表下拉（加载与错误态）", () => {
  it("未选文件时提示先选择 .db 文件", () => {
    renderPanel("db_in", defaultConfigFor("db_in"));
    expect(screen.getByText(/请先选择 \.db 文件/)).toBeInTheDocument();
  });

  it("选择文件后列出表名并写入 config.table", async () => {
    dbTablesMock.mockResolvedValue(["序时账_2026", "科目余额表"]);
    const { onConfigChange } = renderPanel("db_in", {
      ...defaultConfigFor("db_in"),
      path: "D:\\审计\\账套.db",
    });
    const tableSelect = await screen.findByLabelText("数据表");
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "序时账_2026" })).toBeInTheDocument();
    });
    expect(dbTablesMock).toHaveBeenCalledWith("D:\\审计\\账套.db");
    fireEvent.change(tableSelect, { target: { value: "科目余额表" } });
    expect(onConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ table: "科目余额表" }),
    );
  });

  it("读取失败展示中文诊断并支持重试", async () => {
    dbTablesMock.mockRejectedValue({ code: "APP_ERROR", userMessage: "不是有效的 SQLite 文件" });
    renderPanel("db_in", { ...defaultConfigFor("db_in"), path: "D:\\审计\\加密.db" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("读取表清单失败");
    expect(alert.textContent).toContain("不是有效的 SQLite 文件");
    dbTablesMock.mockResolvedValue(["凭证表"]);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "凭证表" })).toBeInTheDocument();
    });
    expect(dbTablesMock).toHaveBeenCalledTimes(2);
  });
});

describe("数据流配置区：其余新节点表单关键控件", () => {
  it("关联：键配对多行可增删，左右字段分别录入", () => {
    const { onConfigChange } = renderLivePanel("join_n", {
      keys: [
        { left: "科目编码", right: "科目代码" },
        { left: "", right: "" },
      ],
      leftFields: [],
      rightFields: [],
      sameNameSuffix: "_右",
    });
    fireEvent.click(screen.getByRole("button", { name: "添加配对" }));
    expect(onConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        keys: [
          { left: "科目编码", right: "科目代码" },
          { left: "", right: "" },
          { left: "", right: "" },
        ],
      }),
    );
    fireEvent.change(screen.getByPlaceholderText("左表字段名，多个用「、」分隔"), {
      target: { value: "凭证号、摘要" },
    });
    expect(onConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ leftFields: ["凭证号", "摘要"] }),
    );
  });

  it("分列：宽度模式可增删宽度行", () => {
    const { onConfigChange } = renderLivePanel("split", {
      ...defaultConfigFor("split"),
      mode: "fixedWidth",
      widths: [4],
    });
    fireEvent.click(screen.getByRole("button", { name: "添加宽度" }));
    expect(onConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ widths: [4, 4] }),
    );
  });

  it("汇总：聚合行的输出名与函数可编辑", () => {
    const { onConfigChange } = renderLivePanel("summarize", {
      groupBy: ["客商名称"],
      aggregations: [{ field: "借方金额", func: "sum", output: "" }],
    });
    fireEvent.change(screen.getByPlaceholderText("输出字段名（可空）"), {
      target: { value: "借方合计" },
    });
    expect(onConfigChange).toHaveBeenLastCalledWith({
      groupBy: ["客商名称"],
      aggregations: [{ field: "借方金额", func: "sum", output: "借方合计" }],
    });
  });

  it("汇总：聚合方式选「非空计数」写入引擎键名 countNonEmpty（非 countNotNull）", () => {
    const { onConfigChange } = renderLivePanel("summarize", {
      groupBy: ["客商名称"],
      aggregations: [{ field: "借方金额", func: "sum", output: "" }],
    });
    fireEvent.change(screen.getByDisplayValue("求和"), { target: { value: "countNonEmpty" } });
    expect(onConfigChange).toHaveBeenLastCalledWith({
      groupBy: ["客商名称"],
      aggregations: [{ field: "借方金额", func: "countNonEmpty", output: "" }],
    });
  });

  it("透视：聚合方式仅列引擎支持的 3 项，选「非空计数」写入 countNonEmpty", () => {
    const { onConfigChange } = renderLivePanel("crosstab", {
      rowField: "客商名称",
      columnField: "期间",
      valueField: "借方金额",
      valueFunc: "sum",
      fill: 0,
    });
    const select = screen.getByLabelText("聚合方式") as HTMLSelectElement;
    // 引擎 run_crosstab 白名单只有 sum / countNonEmpty / distinctCount，
    // 界面不得复用汇总的全量 7 项（countAll/avg/min/max 一选运行必报错）。
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "sum",
      "countNonEmpty",
      "distinctCount",
    ]);
    fireEvent.change(select, { target: { value: "countNonEmpty" } });
    expect(onConfigChange).toHaveBeenLastCalledWith({
      rowField: "客商名称",
      columnField: "期间",
      valueField: "借方金额",
      valueFunc: "countNonEmpty",
      fill: 0,
    });
  });
});
