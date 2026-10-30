// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  DATAFLOW_AVAILABLE_TYPES,
  DATAFLOW_CATEGORIES,
  DATAFLOW_NODE_SPECS,
  anchorAcceptsMultiple,
  nodeSpec,
} from "./nodeSpecs";
import {
  DataflowRunResultSchema,
  DataflowRunResultStrictSchema,
  WorkflowHistory,
  anchorKeyMismatch,
  applyParamPlaceholders,
  canonicalSummarizeFunc,
  configKeysWithinContract,
  createEmptyWorkflow,
  dataflowRunRequest,
  defaultCheckRule,
  defaultConfigFor,
  normalizeCheckRule,
  normalizeConfig,
  parseWorkflowFile,
  removeDraft,
  repairWorkflowEdges,
  saveDraft,
  listDrafts,
  serializeWorkflow,
  validateNewEdge,
  CROSSTAB_VALUE_FUNCS,
  SUMMARIZE_FUNCS,
  type DataflowAnchorResult,
  type DataflowNode,
  type DataflowNodeResult,
  type DataflowRunResult,
  type DataflowWorkflow,
  resolveOutputPaths,
} from "./model";
import { dataflowDemoResult } from "./demoData";
import { ResultsPanel } from "./ResultsPanel";
import { DataflowCanvas, type NodeRunStatus } from "./Canvas";
import { DataFlowPage } from "./DataFlowPage";
import type { ToolManifest } from "../types";

/** 二期补齐的 12 个节点 type（与 Rust 引擎契约一致）。 */
const PHASE2_NODE_TYPES = [
  "join_n",
  "union_n",
  "unique_n",
  "sort_n",
  "summarize",
  "crosstab",
  "transpose",
  "split",
  "check_n",
  "manual_in",
  "db_in",
  "parquet_in",
] as const;

function sampleWorkflow(): DataflowWorkflow {
  const workflow = createEmptyWorkflow("序时账清洗合并_2026");
  workflow.params = [
    { id: "p1", name: "期间", type: "text", value: "2026" },
    { id: "p2", name: "输出文件夹", type: "folder", value: "D:\\审计输出" },
  ];
  workflow.nodes = [
    {
      id: "n1",
      type: "excel_in",
      name: "全年序时账",
      x: 60,
      y: 80,
      config: {
        ...defaultConfigFor("excel_in"),
        sourceType: "folder",
        path: "D:\\某集团审计\\{p1}\\序时账",
        columnTypes: { 科目编码: "text" },
      },
    },
    {
      id: "n2",
      type: "select_n",
      name: "统一字段",
      x: 300,
      y: 80,
      config: {
        ...defaultConfigFor("select_n"),
        fields: [{ source: "借方", keep: true, rename: "借方金额" }],
      },
    },
    {
      id: "n3",
      type: "filter_n",
      name: "筛大额",
      x: 540,
      y: 80,
      config: defaultConfigFor("filter_n"),
    },
    {
      id: "n4",
      type: "excel_out",
      name: "输出·大额清单",
      x: 780,
      y: 80,
      config: { ...defaultConfigFor("excel_out"), fileName: "大额客商_{p1}.xlsx" },
    },
  ];
  workflow.edges = [
    { from: "n1", fromAnchor: "output", to: "n2", toAnchor: "in" },
    { from: "n2", fromAnchor: "output", to: "n3", toAnchor: "in" },
    { from: "n3", fromAnchor: "T", to: "n4", toAnchor: "in" },
  ];
  return workflow;
}

describe("数据流：工作流 JSON 保存/打开往返", () => {
  it("序列化后解析得到等价的工作流", () => {
    const workflow = sampleWorkflow();
    const text = serializeWorkflow(workflow);
    const parsed = parseWorkflowFile(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.workflow.name).toBe("序时账清洗合并_2026");
    expect(parsed.workflow.params).toEqual(workflow.params);
    expect(parsed.workflow.nodes).toEqual(workflow.nodes);
    expect(parsed.workflow.edges).toEqual(workflow.edges);
    expect(parsed.workflow.version).toBe(1);
  });

  it("流程 JSON 键序固定，version 在首位便于人工核对", () => {
    const text = serializeWorkflow(sampleWorkflow());
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"name"'));
    expect(text.indexOf('"params"')).toBeLessThan(text.indexOf('"nodes"'));
    expect(text.indexOf('"nodes"')).toBeLessThan(text.indexOf('"edges"'));
  });

  it("不支持的版本明确报错，不静默打开", () => {
    const parsed = parseWorkflowFile(
      JSON.stringify({ ...sampleWorkflow(), version: 2 }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("版本");
  });

  it("损坏的 JSON 明确报错", () => {
    const parsed = parseWorkflowFile("{不是 json");
    expect(parsed.ok).toBe(false);
  });

  it("打开时用默认 config 补齐缺失字段", () => {
    const raw = {
      version: 1,
      name: "旧流程",
      params: [],
      nodes: [{ id: "n1", type: "csv_in", name: "流水", x: 1, y: 2, config: { path: "E:\\a.csv" } }],
      edges: [],
      notes: [],
    };
    const parsed = parseWorkflowFile(JSON.stringify(raw));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const config = parsed.workflow.nodes[0].config;
    expect(config).toMatchObject({ path: "E:\\a.csv", encoding: "auto", delimiter: "auto" });
    expect(configKeysWithinContract("csv_in", config)).toBe(true);
  });
});

describe("数据流：参数占位替换", () => {
  const params = [
    { id: "p1", name: "期间", type: "text" as const, value: "2026" },
    { id: "p2", name: "输出文件夹", type: "folder" as const, value: "D:\\审计输出" },
  ];

  it("输出 fileName 中的 {参数id} 按覆盖值替换", () => {
    expect(applyParamPlaceholders("大额客商_{p1}.xlsx", params, { p1: "2027" })).toBe(
      "大额客商_2027.xlsx",
    );
  });

  it("无覆盖时使用参数默认值", () => {
    expect(applyParamPlaceholders("大额客商_{p1}.xlsx", params)).toBe("大额客商_2026.xlsx");
  });

  it("路径中的参数占位同样替换", () => {
    expect(applyParamPlaceholders("{p2}\\明细_{p1}.csv", params)).toBe(
      "D:\\审计输出\\明细_2026.csv",
    );
  });

  it("兼容 {参数名} 写法，未定义的占位保持原样", () => {
    expect(applyParamPlaceholders("{期间}年_{不存在}.xlsx", params, { p1: "2025" })).toBe(
      "2025年_{不存在}.xlsx",
    );
  });
});

describe("数据流：锚点连线校验", () => {
  const workflow = sampleWorkflow();

  it("禁止自环", () => {
    const check = validateNewEdge(workflow, {
      from: "n2",
      fromAnchor: "output",
      to: "n2",
      toAnchor: "in",
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("自环");
  });

  it("禁止重复连线", () => {
    const check = validateNewEdge(workflow, {
      from: "n1",
      fromAnchor: "output",
      to: "n2",
      toAnchor: "in",
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("已经存在");
  });

  it("锚点不存在时报错（输出节点没有输出口）", () => {
    const check = validateNewEdge(workflow, {
      from: "n4",
      fromAnchor: "output",
      to: "n2",
      toAnchor: "in",
    });
    expect(check.ok).toBe(false);
  });

  it("单输入口被占用后拒绝再接入", () => {
    const check = validateNewEdge(workflow, {
      from: "n1",
      fromAnchor: "output",
      to: "n3",
      toAnchor: "in",
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("已有连线");
  });

  it("禁止形成环路", () => {
    const cyclic: DataflowWorkflow = {
      ...createEmptyWorkflow("环路检查"),
      nodes: [
        { id: "n2", type: "select_n", name: "统一字段", x: 0, y: 0, config: defaultConfigFor("select_n") },
        { id: "n3", type: "filter_n", name: "筛大额", x: 200, y: 0, config: defaultConfigFor("filter_n") },
      ],
      edges: [{ from: "n2", fromAnchor: "output", to: "n3", toAnchor: "in" }],
    };
    const check = validateNewEdge(cyclic, {
      from: "n3",
      fromAnchor: "T",
      to: "n2",
      toAnchor: "in",
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("环路");
  });

  it("合法连线放行，Excel 输出允许多条上游连线", () => {
    const okEdge = validateNewEdge(workflow, {
      from: "n3",
      fromAnchor: "F",
      to: "n4",
      toAnchor: "in",
    });
    expect(okEdge.ok).toBe(true);
    const withBoth = {
      ...workflow,
      edges: [
        ...workflow.edges,
        { from: "n3", fromAnchor: "F", to: "n4", toAnchor: "in" },
      ],
    };
    const second = validateNewEdge(withBoth, {
      from: "n2",
      fromAnchor: "output",
      to: "n4",
      toAnchor: "in",
    });
    expect(second.ok).toBe(true);
  });

  it("关联节点左右两个输入口各自只允许一条连线", () => {
    const joinFlow: DataflowWorkflow = {
      ...createEmptyWorkflow("关联连线"),
      nodes: [
        { id: "n1", type: "excel_in", name: "左表", x: 0, y: 0, config: defaultConfigFor("excel_in") },
        { id: "n2", type: "csv_in", name: "右表", x: 0, y: 200, config: defaultConfigFor("csv_in") },
        { id: "n3", type: "join_n", name: "关联", x: 300, y: 100, config: defaultConfigFor("join_n") },
      ],
      edges: [
        { from: "n1", fromAnchor: "output", to: "n3", toAnchor: "inL" },
        { from: "n2", fromAnchor: "output", to: "n3", toAnchor: "inR" },
      ],
    };
    // 左口占用后，另一条线想再进左口应被拒绝。
    const leftTaken = validateNewEdge(joinFlow, {
      from: "n2",
      fromAnchor: "output",
      to: "n3",
      toAnchor: "inL",
    });
    expect(leftTaken.ok).toBe(false);
    if (leftTaken.ok) return;
    expect(leftTaken.reason).toContain("已有连线");
    expect(anchorAcceptsMultiple("join_n", "inL")).toBe(false);
    expect(anchorAcceptsMultiple("join_n", "inR")).toBe(false);
    expect(anchorAcceptsMultiple("union_n", "in")).toBe(true);
  });

  it("纵向合并输入口允许多条上游连线", () => {
    const unionFlow: DataflowWorkflow = {
      ...createEmptyWorkflow("合并连线"),
      nodes: [
        { id: "n1", type: "excel_in", name: "表一", x: 0, y: 0, config: defaultConfigFor("excel_in") },
        { id: "n2", type: "csv_in", name: "表二", x: 0, y: 200, config: defaultConfigFor("csv_in") },
        { id: "n3", type: "union_n", name: "合并", x: 300, y: 100, config: defaultConfigFor("union_n") },
      ],
      edges: [{ from: "n1", fromAnchor: "output", to: "n3", toAnchor: "in" }],
    };
    const second = validateNewEdge(unionFlow, {
      from: "n2",
      fromAnchor: "output",
      to: "n3",
      toAnchor: "in",
    });
    expect(second.ok).toBe(true);
  });
});

describe("数据流：节点目录完整性（20 个全部可用）", () => {
  it("全部 20 个节点不再置灰（phase2 = false），与可用集合一致", () => {
    const enabled = DATAFLOW_NODE_SPECS.filter((spec) => !spec.phase2).map((spec) => spec.type);
    expect(enabled.sort()).toEqual([...DATAFLOW_AVAILABLE_TYPES].sort());
    expect(DATAFLOW_NODE_SPECS.every((spec) => spec.phase2 === false)).toBe(true);
  });

  it("二期补齐的 12 个节点都在目录中", () => {
    for (const type of PHASE2_NODE_TYPES) {
      expect(nodeSpec(type), `缺少 ${type} 的目录定义`).toBeDefined();
    }
  });

  it("目录共 20 个节点、7 个分类且顺序固定", () => {
    expect(DATAFLOW_NODE_SPECS).toHaveLength(20);
    expect(DATAFLOW_CATEGORIES.map((item) => item.cn)).toEqual([
      "输入", "整理", "筛选排序", "关联合并", "汇总变形", "校验", "输出",
    ]);
  });

  it("各分类节点数与设计文档第 4 节一致", () => {
    const count = (category: string) =>
      DATAFLOW_NODE_SPECS.filter((spec) => spec.category === category).length;
    expect(count("input")).toBe(5);
    expect(count("transform")).toBe(4);
    expect(count("filtersort")).toBe(3);
    expect(count("join")).toBe(2);
    expect(count("aggregate")).toBe(3);
    expect(count("check")).toBe(1);
    expect(count("output")).toBe(2);
  });

  it("多路输出锚点齐备：筛选 T/F、去重 U/D、关联 J/L/R、检查 P/NG", () => {
    expect(nodeSpec("filter_n")?.outputs.map((anchor) => anchor.key)).toEqual(["T", "F"]);
    expect(nodeSpec("unique_n")?.outputs.map((anchor) => anchor.key)).toEqual(["U", "D"]);
    expect(nodeSpec("unique_n")?.outputs.map((anchor) => anchor.label)).toEqual(["U 保留", "D 重复"]);
    const join = nodeSpec("join_n");
    expect(join?.inputs.map((anchor) => anchor.key)).toEqual(["inL", "inR"]);
    expect(join?.inputs.map((anchor) => anchor.label)).toEqual(["左表", "右表"]);
    expect(join?.outputs.map((anchor) => anchor.key)).toEqual(["J", "L", "R"]);
    expect(join?.outputs.map((anchor) => anchor.label)).toEqual([
      "J 匹配", "L 左未匹配", "R 右未匹配",
    ]);
    const check = nodeSpec("check_n");
    expect(check?.outputs.map((anchor) => anchor.key)).toEqual(["P", "NG"]);
    expect(check?.outputs.map((anchor) => anchor.label)).toEqual(["P 通过", "NG 未通过"]);
    // 单输入节点与输出节点锚点保持第一期形态。
    for (const type of ["sort_n", "summarize", "crosstab", "transpose", "split", "check_n"]) {
      expect(nodeSpec(type)?.inputs.map((anchor) => anchor.key), type).toEqual(["in"]);
    }
    expect(nodeSpec("excel_out")?.outputs).toEqual([]);
    expect(nodeSpec("csv_out")?.outputs).toEqual([]);
    for (const type of DATAFLOW_AVAILABLE_TYPES) {
      const spec = nodeSpec(type);
      expect(spec, `缺少 ${type} 的目录定义`).toBeDefined();
    }
  });
});

describe("数据流：config 序列化", () => {
  it("excel_in 默认 config 与引擎契约逐字段一致", () => {
    expect(defaultConfigFor("excel_in")).toEqual({
      sourceType: "file",
      path: "",
      filePattern: "*.xlsx;*.xls;*.csv",
      sheetMode: "firstData",
      sheetName: "",
      headerRow: 1,
      dataStartRow: 2,
      attachSourceColumns: true,
      onRowError: "stop",
      columnTypes: {},
    });
  });

  it("csv_in / 输出节点默认 config 与契约一致", () => {
    expect(defaultConfigFor("csv_in")).toEqual({
      sourceType: "file",
      path: "",
      encoding: "auto",
      delimiter: "auto",
      headerRow: 1,
      attachSourceColumns: true,
      onRowError: "stop",
      columnTypes: {},
    });
    expect(defaultConfigFor("excel_out")).toEqual({
      fileName: "",
      sheetName: "",
      overwrite: "error",
      splitMode: "sheet",
    });
    expect(defaultConfigFor("csv_out")).toEqual({
      fileName: "",
      encoding: "gbk",
      delimiter: "comma",
      splitRows: 0,
    });
  });

  it("筛选条件序列化为契约结构（op + rules）", () => {
    const condition = defaultConfigFor("filter_n").condition as {
      op: string;
      rules: { field: string; operator: string; value: string }[];
    };
    expect(condition.op).toBe("and");
    expect(condition.rules).toEqual([{ field: "", operator: "=", value: "" }]);

    const normalized = normalizeConfig("filter_n", {
      condition: { op: "or", rules: [{ field: "借方合计", operator: ">=", value: 500000 }] },
    }).condition as { op: string; rules: { value: string }[] };
    expect(normalized.op).toBe("or");
    expect(normalized.rules[0].value).toBe("500000");
  });

  it("二期 12 节点默认 config 与第八节裁定逐字段一致", () => {
    expect(defaultConfigFor("join_n")).toEqual({
      keys: [{ left: "", right: "" }],
      leftFields: [],
      rightFields: [],
      sameNameSuffix: "_右",
    });
    expect(defaultConfigFor("union_n")).toEqual({
      align: "byName",
      extraFieldPolicy: "keep",
      typeConflictPolicy: "text",
      order: [],
    });
    expect(defaultConfigFor("unique_n")).toEqual({ fields: [], keep: "first" });
    expect(defaultConfigFor("sort_n")).toEqual({
      rules: [{ field: "", direction: "asc", nulls: "last" }],
    });
    expect(defaultConfigFor("summarize")).toEqual({
      groupBy: [],
      aggregations: [{ field: "", func: "countAll", output: "" }],
    });
    expect(defaultConfigFor("crosstab")).toEqual({
      rowField: "",
      columnField: "",
      valueField: "",
      valueFunc: "sum",
      fill: 0,
    });
    expect(defaultConfigFor("transpose")).toEqual({
      fixedFields: [],
      valueColumns: [],
      nameColumn: "项目",
      valueColumn: "数值",
    });
    expect(defaultConfigFor("split")).toEqual({
      field: "",
      mode: "delimiter",
      delimiter: "",
      widths: [],
      keepOriginal: false,
      columnPrefix: "",
    });
    expect(defaultConfigFor("check_n")).toEqual({ rules: [] });
    expect(defaultConfigFor("manual_in")).toEqual({
      columns: [{ name: "列名", type: "text" }],
      rows: [[""]],
      onRowError: "stop",
    });
    expect(defaultConfigFor("db_in")).toEqual({
      path: "",
      table: "",
      fields: [],
      onRowError: "stop",
    });
    expect(defaultConfigFor("parquet_in")).toEqual({ path: "", fields: [] });
  });

  it("全部 20 种节点默认 config 只含契约内字段", () => {
    for (const type of DATAFLOW_AVAILABLE_TYPES) {
      expect(configKeysWithinContract(type, defaultConfigFor(type)), type).toBe(true);
      expect(
        configKeysWithinContract(type, { ...defaultConfigFor(type), 额外字段: 1 }),
        type,
      ).toBe(false);
    }
  });

  it("二期节点编辑后的 config 序列化往返不丢字段", () => {
    const edited: Record<string, Record<string, unknown>> = {
      join_n: {
        keys: [{ left: "科目编码", right: "科目代码" }],
        leftFields: ["凭证号", "摘要"],
        rightFields: ["科目名称"],
        sameNameSuffix: "_右表",
      },
      union_n: { align: "byPosition", extraFieldPolicy: "drop", typeConflictPolicy: "stop", order: ["n2", "n3"] },
      unique_n: { fields: ["凭证号", "客商名称"], keep: "last" },
      sort_n: { rules: [{ field: "借方金额", direction: "desc", nulls: "first" }] },
      summarize: {
        groupBy: ["客商名称"],
        aggregations: [
          { field: "借方金额", func: "sum", output: "借方合计" },
          { field: "", func: "countAll", output: "凭证笔数" },
        ],
      },
      crosstab: { rowField: "客商名称", columnField: "期间", valueField: "借方金额", valueFunc: "sum", fill: null },
      transpose: { fixedFields: ["科目编码"], valueColumns: ["期初余额", "期末余额"], nameColumn: "项目", valueColumn: "数值" },
      split: { field: "科目编码", mode: "fixedWidth", delimiter: "", widths: [4, 4], keepOriginal: true, columnPrefix: "段" },
      check_n: {
        rules: [
          { type: "balance", groupBy: ["凭证号"], debitField: "借方金额", creditField: "贷方金额", tolerance: 0.01 },
          { type: "notEmpty", fields: ["客商名称"] },
          { type: "unique", field: "凭证号", groupBy: [] },
          { type: "range", field: "金额", min: 0, max: 1000000 },
          { type: "expression", expression: "借方金额 >= 0" },
        ],
      },
      manual_in: {
        columns: [
          { name: "科目编码", type: "text" },
          { name: "金额", type: "decimal" },
        ],
        rows: [["1002", "1250.00"], ["1122", "468.20"]],
        onRowError: "skip",
      },
      db_in: { path: "D:\\审计\\账套.db", table: "序时账_2026", fields: ["凭证号", "金额"], onRowError: "stop" },
      parquet_in: { path: "D:\\缓存\\明细.parquet", fields: [] },
    };
    for (const [type, config] of Object.entries(edited)) {
      const workflow = createEmptyWorkflow("往返");
      workflow.nodes = [{ id: "n1", type, name: "节点", x: 0, y: 0, config }];
      const parsed = parseWorkflowFile(serializeWorkflow(workflow));
      expect(parsed.ok, type).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.workflow.nodes[0].config, type).toEqual(config);
    }
  });

  it("normalizeConfig 补齐缺失字段并纠正数字类型", () => {
    const config = normalizeConfig("excel_in", {
      path: "D:\\a.xlsx",
      headerRow: "3",
      attachSourceColumns: "yes",
    });
    expect(config.headerRow).toBe(3);
    expect(config.attachSourceColumns).toBe(false);
    expect(config.sheetMode).toBe("firstData");
  });

  it("normalizeConfig 纠正二期节点的数组与枚举（打开旧文件兜底）", () => {
    expect(normalizeConfig("join_n", { keys: "坏数据", leftFields: "科目" }).keys).toEqual([
      { left: "", right: "" },
    ]);
    expect(normalizeConfig("union_n", { align: "乱写" }).align).toBe("byName");
    expect(normalizeConfig("unique_n", { keep: "乱写" }).keep).toBe("first");
    expect(normalizeConfig("sort_n", { rules: [{ field: "金额", direction: "乱写", nulls: "first" }] }).rules).toEqual([
      { field: "金额", direction: "asc", nulls: "first" },
    ]);
    expect(
      normalizeConfig("summarize", { aggregations: [{ field: "金额", func: "乱写", output: "x" }] })
        .aggregations,
    ).toEqual([{ field: "金额", func: "countAll", output: "x" }]);
    expect(normalizeConfig("crosstab", { fill: "乱写" }).fill).toBe(0);
    expect(normalizeConfig("crosstab", { fill: null }).fill).toBeNull();
    expect(normalizeConfig("split", { widths: ["4", 0, 6], keepOriginal: "yes" }).widths).toEqual([4, 6]);
    expect(normalizeConfig("split", { keepOriginal: 1 }).keepOriginal).toBe(false);
    expect(normalizeConfig("manual_in", { columns: [{ name: "x", type: "乱写" }], rows: [["a", 1]] })).toMatchObject({
      columns: [{ name: "x", type: "text" }],
      rows: [["a", "1"]],
    });
    // 无法识别的检查规则被丢弃，可识别的按类型收紧字段。
    expect(
      normalizeConfig("check_n", {
        rules: [{ type: "乱写" }, { type: "balance", groupBy: "凭证号", tolerance: "0.01" }],
      }).rules,
    ).toEqual([{ type: "balance", groupBy: ["凭证号"], debitField: "", creditField: "", tolerance: 0.01 }]);
  });

  it("分列拆分方式与引擎契约对齐：旧值 width 迁移为 fixedWidth，非法值回退分隔符", () => {
    // 引擎 split.rs 只认 delimiter / fixedWidth；旧流程文件的 width 必须迁移而不是回退。
    expect(normalizeConfig("split", { mode: "width", widths: [4] }).mode).toBe("fixedWidth");
    expect(normalizeConfig("split", { mode: "fixedWidth", widths: [4] }).mode).toBe("fixedWidth");
    expect(normalizeConfig("split", { mode: "乱写" }).mode).toBe("delimiter");
    expect(normalizeConfig("split", {}).mode).toBe("delimiter");
  });

  it("分列固定宽度模式前端→引擎：取值经规整、保存往返与运行请求后仍为 fixedWidth", () => {
    // 界面「按固定宽度」选项值即引擎契约值，运行请求体平铺后引擎可直接识别。
    const config = normalizeConfig("split", {
      field: "科目编码",
      mode: "fixedWidth",
      widths: [4, 4],
      keepOriginal: true,
      columnPrefix: "段",
    });
    const workflow = createEmptyWorkflow("固定宽度拆分");
    workflow.nodes = [{ id: "n1", type: "split", name: "分列", x: 0, y: 0, config }];
    const parsed = parseWorkflowFile(serializeWorkflow(workflow));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const reopened = normalizeConfig("split", parsed.workflow.nodes[0].config);
    const payload = dataflowRunRequest(
      { ...workflow, nodes: [{ ...workflow.nodes[0], config: reopened }] },
      "preview",
      {},
    );
    const splitNode = (payload.nodes as { type: string; config: { mode?: string } }[]).find(
      (node) => node.type === "split",
    );
    expect(splitNode?.config.mode).toBe("fixedWidth");
  });

  it("汇总/透视聚合函数键名与引擎白名单一致（countNonEmpty/distinctCount）", () => {
    // 引擎 aggregate.rs func_display 白名单（键名原样透传给 Rust，前端不得自造别名）。
    expect(SUMMARIZE_FUNCS.map((fn) => fn.value)).toEqual([
      "countAll", "sum", "countNonEmpty", "distinctCount", "avg", "min", "max",
    ]);
    // 旧版前端错误键名不得再出现在枚举里。
    expect(SUMMARIZE_FUNCS.some((fn) => fn.value === ("countNotNull" as never))).toBe(false);
    expect(SUMMARIZE_FUNCS.some((fn) => fn.value === ("countDistinct" as never))).toBe(false);
    // 透视引擎 run_crosstab 仅支持 3 项。
    expect(CROSSTAB_VALUE_FUNCS.map((fn) => fn.value)).toEqual([
      "sum", "countNonEmpty", "distinctCount",
    ]);
    // 键名规整：旧键迁移、引擎键保留、未知返回 null。
    expect(canonicalSummarizeFunc("countNotNull")).toBe("countNonEmpty");
    expect(canonicalSummarizeFunc("countDistinct")).toBe("distinctCount");
    expect(canonicalSummarizeFunc("distinctCount")).toBe("distinctCount");
    expect(canonicalSummarizeFunc("sum")).toBe("sum");
    expect(canonicalSummarizeFunc("乱写")).toBeNull();
  });

  it("旧流程文件的 countNotNull/countDistinct 打开时迁移为引擎键名，透视白名单外回落求和", () => {
    // 汇总：旧键名逐条迁移，不再落入「无法识别」报错。
    expect(
      normalizeConfig("summarize", {
        groupBy: ["客商名称"],
        aggregations: [
          { field: "客商名称", func: "countNotNull", output: "非空家数" },
          { field: "客商名称", func: "countDistinct", output: "去重家数" },
          { field: "", func: "countAll", output: "" },
          { field: "金额", func: "乱写", output: "x" },
        ],
      }).aggregations,
    ).toEqual([
      { field: "客商名称", func: "countNonEmpty", output: "非空家数" },
      { field: "客商名称", func: "distinctCount", output: "去重家数" },
      { field: "", func: "countAll", output: "" },
      { field: "金额", func: "countAll", output: "x" },
    ]);
    // 透视：引擎仅支持 sum/countNonEmpty/distinctCount；旧键迁移后可用，
    // 白名单外（countAll/avg/min/max/乱写）回落默认「求和」。
    expect(normalizeConfig("crosstab", { valueFunc: "countNotNull" }).valueFunc).toBe("countNonEmpty");
    expect(normalizeConfig("crosstab", { valueFunc: "countDistinct" }).valueFunc).toBe("distinctCount");
    expect(normalizeConfig("crosstab", { valueFunc: "countNonEmpty" }).valueFunc).toBe("countNonEmpty");
    expect(normalizeConfig("crosstab", { valueFunc: "avg" }).valueFunc).toBe("sum");
    expect(normalizeConfig("crosstab", { valueFunc: "countAll" }).valueFunc).toBe("sum");
    expect(normalizeConfig("crosstab", { valueFunc: "乱写" }).valueFunc).toBe("sum");
  });

  it("打开含旧聚合键名的流程文件：解析即迁移，运行请求体只含引擎键名", () => {
    const legacy = {
      version: 1,
      name: "旧流程",
      params: [],
      nodes: [
        {
          id: "n1",
          type: "summarize",
          name: "汇总",
          x: 0,
          y: 0,
          config: {
            groupBy: ["客商名称"],
            aggregations: [{ field: "客商名称", func: "countNotNull", output: "" }],
          },
        },
        {
          id: "n2",
          type: "crosstab",
          name: "透视",
          x: 200,
          y: 0,
          config: { rowField: "客商名称", columnField: "期间", valueField: "金额", valueFunc: "countDistinct", fill: 0 },
        },
      ],
      edges: [{ from: "n1", fromAnchor: "output", to: "n2", toAnchor: "in" }],
      notes: [],
    };
    const parsed = parseWorkflowFile(JSON.stringify(legacy));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const summarizeConfig = parsed.workflow.nodes[0].config as { aggregations: { func: string }[] };
    expect(summarizeConfig.aggregations[0].func).toBe("countNonEmpty");
    expect(parsed.workflow.nodes[1].config.valueFunc).toBe("distinctCount");
    // 运行请求体平铺工作流，引擎收到的键名已是白名单内的值。
    const payload = dataflowRunRequest(parsed.workflow, "preview", {});
    const nodes = payload.nodes as { type: string; config: Record<string, unknown> }[];
    expect((nodes[0].config.aggregations as { func: string }[])[0].func).toBe("countNonEmpty");
    expect(nodes[1].config.valueFunc).toBe("distinctCount");
  });

  it("检查规则默认值按类型给出（容差默认 0＝精确相等）", () => {
    expect(defaultCheckRule("balance")).toEqual({
      type: "balance",
      groupBy: [],
      debitField: "",
      creditField: "",
      tolerance: 0,
    });
    expect(defaultCheckRule("range")).toEqual({ type: "range", field: "", min: null, max: null });
    expect(normalizeCheckRule({ type: "expression", expression: "金额 > 0" })).toEqual({
      type: "expression",
      expression: "金额 > 0",
    });
    expect(normalizeCheckRule({ type: "不存在" })).toBeNull();
  });

  it("检查规则兼容手写流程文件的 kind 判别与单字符串分组（不再被丢弃）", () => {
    expect(
      normalizeCheckRule({
        kind: "balance",
        groupBy: "凭",
        debitField: "借方",
        creditField: "贷方",
        tolerance: 0.01,
      }),
    ).toEqual({
      type: "balance",
      groupBy: ["凭"],
      debitField: "借方",
      creditField: "贷方",
      tolerance: 0.01,
    });
    expect(normalizeCheckRule({ kind: "unique", field: "凭证号", groupBy: "凭" })).toEqual({
      type: "unique",
      field: "凭证号",
      groupBy: ["凭"],
    });
    expect(normalizeCheckRule({ kind: "乱写" })).toBeNull();
    // kind 形态的流程文件打开后规则保留，并规整回界面 type 形态
    //（此前 normalizeCheckRule 不识别 kind，手工改的规则打开即被丢弃）。
    const parsed = parseWorkflowFile(
      JSON.stringify({
        version: 1,
        name: "手写检查",
        params: [],
        nodes: [
          {
            id: "n1",
            type: "check_n",
            name: "检查",
            x: 0,
            y: 0,
            config: { rules: [{ kind: "notEmpty", fields: ["金额"] }] },
          },
        ],
        edges: [],
        notes: [],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.workflow.nodes[0].config as { rules: unknown[] }).rules).toEqual([
      { type: "notEmpty", fields: ["金额"] },
    ]);
  });

  it("检查规则前端→引擎契约：五类规则 type 判别＋groupBy 数组经保存/打开/运行请求保持不变", () => {
    // 引擎 nodes/check.rs 归一层接受 type 判别与 groupBy 数组；本测试锁定
    // 界面五类规则的序列化形态，任一侧契约漂移（判别字段或分组形态改形）即失败。
    const rules = (["balance", "notEmpty", "unique", "range", "expression"] as const).map(
      defaultCheckRule,
    );
    const workflow = createEmptyWorkflow("检查契约");
    workflow.nodes = [{ id: "n1", type: "check_n", name: "检查", x: 0, y: 0, config: { rules } }];
    const parsed = parseWorkflowFile(serializeWorkflow(workflow));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const payload = dataflowRunRequest(parsed.workflow, "full", {});
    const sent = (
      payload.nodes as { config: { rules: { type: string; groupBy?: string[] }[] } }[]
    )[0].config.rules;
    expect(sent.map((rule) => rule.type)).toEqual([
      "balance",
      "notEmpty",
      "unique",
      "range",
      "expression",
    ]);
    for (const rule of sent) {
      if ("groupBy" in rule) expect(Array.isArray(rule.groupBy)).toBe(true);
    }
  });
});

describe("数据流：运行请求形状（uptoNodeId）", () => {
  const workflow = sampleWorkflow();

  it("普通全量运行不带 uptoNodeId，runMode 与 paramOverrides 平级", () => {
    const payload = dataflowRunRequest(workflow, "full", { p1: "2027" });
    expect(payload.runMode).toBe("full");
    expect(payload.paramOverrides).toEqual({ p1: "2027" });
    expect(payload.uptoNodeId).toBeUndefined();
    expect(payload.nodes).toEqual(workflow.nodes);
    expect(payload.version).toBe(1);
  });

  it("运行到选中节点时附 uptoNodeId（与 paramOverrides 平级）", () => {
    const payload = dataflowRunRequest(workflow, "full", { p1: "2027" }, "n3");
    expect(payload.uptoNodeId).toBe("n3");
    expect(payload.runMode).toBe("full");
    expect(payload.paramOverrides).toEqual({ p1: "2027" });
  });

  it("uptoNodeId 为空字符串时不附该键", () => {
    expect(dataflowRunRequest(workflow, "preview", {}, "").uptoNodeId).toBeUndefined();
  });
});

describe("数据流：草稿与撤销栈", () => {
  it("草稿按键含流程名保存并可恢复、可清除", () => {
    const workflow = sampleWorkflow();
    expect(saveDraft(workflow)).toBe(true);
    const drafts = listDrafts().filter((draft) => draft.name === workflow.name);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].workflow.nodes).toHaveLength(4);
    removeDraft(workflow.name);
    expect(listDrafts().filter((draft) => draft.name === workflow.name)).toHaveLength(0);
  });

  it("空流程不落草稿：改名后无节点的流程也不会顶掉含节点草稿的恢复位", () => {
    const withNodes = sampleWorkflow();
    expect(saveDraft(withNodes)).toBe(true);
    const empty = createEmptyWorkflow("只有名字没有节点");
    expect(saveDraft(empty)).toBe(false);
    const drafts = listDrafts();
    expect(drafts.some((draft) => draft.name === empty.name)).toBe(false);
    expect(drafts.some((draft) => draft.name === withNodes.name)).toBe(true);
    removeDraft(withNodes.name);
  });

  it("跨版本过期连线自动修正：筛选上的旧出口名改接 T，正常连线不动", () => {
    const wf = createEmptyWorkflow("旧流程");
    wf.nodes = [
      { id: "n1", type: "excel_in", name: "输入", x: 0, y: 0, config: {} as never },
      { id: "n2", type: "filter_n", name: "筛选", x: 200, y: 0, config: {} as never },
      { id: "n3", type: "excel_out", name: "输出", x: 400, y: 0, config: {} as never },
    ];
    wf.edges = [
      { from: "n1", fromAnchor: "output", to: "n2", toAnchor: "in" },
      { from: "n2", fromAnchor: "output", to: "n3", toAnchor: "in" },
    ];
    const { workflow, fixes } = repairWorkflowEdges(wf);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toContain("筛选");
    expect(workflow.edges[0].fromAnchor).toBe("output");
    expect(workflow.edges[1].fromAnchor).toBe("T");
    // 再修一遍应无变化（幂等）。
    expect(repairWorkflowEdges(workflow).fixes).toHaveLength(0);
  });

  it("关联节点两条都缺 toAnchor：按连线顺序先左后右补位，不再统一改到 inL 制造冲突", () => {
    const wf = createEmptyWorkflow("手工编辑的关联流程");
    wf.nodes = [
      { id: "n1", type: "excel_in", name: "左表", x: 0, y: 0, config: {} as never },
      { id: "n2", type: "csv_in", name: "右表", x: 0, y: 200, config: {} as never },
      { id: "n3", type: "join_n", name: "关联", x: 300, y: 100, config: {} as never },
    ];
    // 两条边 toAnchor 均缺失（parseWorkflowFile 会归一为空串）。
    wf.edges = [
      { from: "n1", fromAnchor: "output", to: "n3", toAnchor: "" },
      { from: "n2", fromAnchor: "output", to: "n3", toAnchor: "" },
    ];
    const { workflow, fixes } = repairWorkflowEdges(wf);
    // 与引擎缺省补位语义一致（engine.rs：空 to_anchor 先占左、后占右）。
    expect(workflow.edges[0].toAnchor).toBe("inL");
    expect(workflow.edges[1].toAnchor).toBe("inR");
    expect(fixes).toHaveLength(2);
    expect(fixes[0]).toContain("左表");
    expect(fixes[1]).toContain("右表");
    // 幂等：修正后再修不产生新改动。
    expect(repairWorkflowEdges(workflow).fixes).toHaveLength(0);
  });

  it("关联节点已有显式 inL 连线时，缺锚点的连线补到未占用的 inR", () => {
    const wf = createEmptyWorkflow("显式左侧");
    wf.nodes = [
      { id: "n1", type: "excel_in", name: "左表", x: 0, y: 0, config: {} as never },
      { id: "n2", type: "csv_in", name: "右表", x: 0, y: 200, config: {} as never },
      { id: "n3", type: "join_n", name: "关联", x: 300, y: 100, config: {} as never },
    ];
    wf.edges = [
      { from: "n1", fromAnchor: "output", to: "n3", toAnchor: "inL" },
      { from: "n2", fromAnchor: "output", to: "n3", toAnchor: "" },
    ];
    const { workflow, fixes } = repairWorkflowEdges(wf);
    expect(workflow.edges[0].toAnchor).toBe("inL");
    expect(workflow.edges[1].toAnchor).toBe("inR");
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toContain("右表");
  });

  it("无效入口键（非空乱值）同样按未占用槽位补齐；单输入口节点行为不变", () => {
    const wf = createEmptyWorkflow("乱值锚点");
    wf.nodes = [
      { id: "n1", type: "excel_in", name: "左表", x: 0, y: 0, config: {} as never },
      { id: "n2", type: "csv_in", name: "右表", x: 0, y: 200, config: {} as never },
      { id: "n3", type: "join_n", name: "关联", x: 300, y: 100, config: {} as never },
      { id: "n4", type: "clean", name: "清洗", x: 600, y: 100, config: {} as never },
    ];
    wf.edges = [
      { from: "n1", fromAnchor: "output", to: "n3", toAnchor: "left" },
      { from: "n2", fromAnchor: "output", to: "n3", toAnchor: "left" },
      { from: "n3", fromAnchor: "J", to: "n4", toAnchor: "入口" },
    ];
    const { workflow, fixes } = repairWorkflowEdges(wf);
    expect(workflow.edges[0].toAnchor).toBe("inL");
    expect(workflow.edges[1].toAnchor).toBe("inR");
    // 单输入口节点仍改接唯一输入口（原行为）。
    expect(workflow.edges[2].toAnchor).toBe("in");
    expect(fixes).toHaveLength(3);
  });

  it("撤销/重做操作栈往返一致", () => {
    const history = new WorkflowHistory();
    const first = createEmptyWorkflow("一");
    const second = { ...first, name: "二" };
    const third = { ...first, name: "三" };
    history.snapshot(first);
    history.snapshot(second);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
    expect(history.undo(third)?.name).toBe("二");
    expect(history.undo(second)?.name).toBe("一");
    expect(history.canUndo).toBe(false);
    expect(history.redo(first)?.name).toBe("二");
    expect(history.redo(second)?.name).toBe("三");
  });
});

describe("数据流：浏览器预览演示数据", () => {
  it("演示结果符合引擎响应契约", () => {
    const workflow = sampleWorkflow();
    const preview = dataflowDemoResult("preview", workflow, {});
    expect(() => DataflowRunResultSchema.parse(preview)).not.toThrow();
    expect(preview.mode).toBe("preview");
    expect(preview.error).toBeNull();
    expect(preview.nodes[workflow.nodes[0].id].anchors.output.columns).toContain("凭证号");

    const full = dataflowDemoResult("full", workflow, { p1: "2027" });
    expect(DataflowRunResultSchema.parse(full).mode).toBe("full");
    const outputEntry = full.outputs.find((item) => item.nodeId === "n4");
    expect(outputEntry?.path).toContain("大额客商_2027.xlsx");
  });

  it("缺少上游连线的节点在演示中明确失败", () => {
    const workflow = createEmptyWorkflow("孤立节点");
    workflow.nodes = [
      { id: "n1", type: "clean", name: "清洗", x: 0, y: 0, config: defaultConfigFor("clean") },
    ];
    const result = dataflowDemoResult("preview", workflow);
    expect(result.nodes.n1.status).toBe("error");
    expect(result.nodes.n1.messages[0]).toContain("上游连线");
  });

  it("关联节点演示给出 J/L/R 三路锚点与膨胀统计", () => {
    const workflow = createEmptyWorkflow("关联演示");
    workflow.nodes = [
      { id: "n1", type: "excel_in", name: "左表", x: 0, y: 0, config: defaultConfigFor("excel_in") },
      { id: "n2", type: "csv_in", name: "右表", x: 0, y: 200, config: defaultConfigFor("csv_in") },
      { id: "n3", type: "join_n", name: "关联", x: 300, y: 100, config: defaultConfigFor("join_n") },
    ];
    workflow.edges = [
      { from: "n1", fromAnchor: "output", to: "n3", toAnchor: "inL" },
      { from: "n2", fromAnchor: "output", to: "n3", toAnchor: "inR" },
    ];
    const result = dataflowDemoResult("full", workflow);
    expect(() => DataflowRunResultSchema.parse(result)).not.toThrow();
    const join = result.nodes.n3;
    expect(Object.keys(join.anchors).sort()).toEqual(["J", "L", "R"]);
    expect(join.stats.join("；")).toContain("膨胀");
    // 左口缺线时关联节点应失败。
    const broken = dataflowDemoResult("full", {
      ...workflow,
      edges: [{ from: "n1", fromAnchor: "output", to: "n3", toAnchor: "inL" }],
    });
    expect(broken.nodes.n3.status).toBe("error");
  });

  it("去重/检查节点演示给出 U/D、P/NG 锚点", () => {
    const workflow = createEmptyWorkflow("多路演示");
    workflow.nodes = [
      { id: "n1", type: "excel_in", name: "输入", x: 0, y: 0, config: defaultConfigFor("excel_in") },
      { id: "n2", type: "unique_n", name: "去重", x: 300, y: 0, config: defaultConfigFor("unique_n") },
      { id: "n3", type: "check_n", name: "检查", x: 600, y: 0, config: defaultConfigFor("check_n") },
    ];
    workflow.edges = [
      { from: "n1", fromAnchor: "output", to: "n2", toAnchor: "in" },
      { from: "n2", fromAnchor: "U", to: "n3", toAnchor: "in" },
    ];
    const result = dataflowDemoResult("preview", workflow);
    expect(Object.keys(result.nodes.n2.anchors).sort()).toEqual(["D", "U"]);
    expect(Object.keys(result.nodes.n3.anchors).sort()).toEqual(["NG", "P"]);
    expect(result.nodes.n3.anchors.NG.columns).toContain("违规原因");
  });

  it("uptoNodeId：演示结果只含目标节点及其上游，其后节点不出现", () => {
    const workflow = sampleWorkflow(); // n1 → n2 → n3(T) → n4
    const result = dataflowDemoResult("full", workflow, {}, "n3");
    expect(() => DataflowRunResultSchema.parse(result)).not.toThrow();
    expect(Object.keys(result.nodes).sort()).toEqual(["n1", "n2", "n3"]);
    expect(result.nodes.n4).toBeUndefined();
    expect(result.outputs).toEqual([]);
    // 未知节点 id：与真实引擎对齐（engine.rs upstream_closure 报
    // DATAFLOW_UPTO_NODE_MISSING），返回错误结果而非静默全量执行。
    const missing = dataflowDemoResult("full", workflow, {}, "nX");
    expect(missing.error).toMatchObject({ code: "DATAFLOW_UPTO_NODE_MISSING" });
    expect((missing.error as { userMessage?: string }).userMessage).toContain("nX");
    expect((missing.error as { userMessage?: string }).userMessage).toContain("不存在");
    expect(Object.keys(missing.nodes)).toHaveLength(0);
    expect(missing.outputs).toEqual([]);
    expect(() => DataflowRunResultSchema.parse(missing)).not.toThrow();
  });
});

// ===== 输出节点「写入结果」页签的锚点契约 =====
// 真实引擎（nodes/output.rs）预览分支对 excel_out/csv_out 返回的锚点键是
// 「sheet:名」/「file:名.扩展名」（engine.rs 测试 row_count(&result, "out", "sheet:CSV输入")
// 实证），此前前端只认 anchors.out，导致预览样本永不展示、永远显示
// 「预览模式：未写入文件。」占位——这里按引擎真实形态 mock 组件做防回归。

describe("数据流：输出节点预览「写入结果」按 sheet:/file: 锚点展示", () => {
  afterEach(() => cleanup());

  function outNode(type: "excel_out" | "csv_out"): DataflowNode {
    return {
      id: "out1",
      type,
      name: "输出·大额清单",
      x: 0,
      y: 0,
      config: defaultConfigFor(type),
    };
  }

  function anchorOf(
    columns: string[],
    sample: (string | number | boolean | null)[][],
  ): DataflowAnchorResult {
    return {
      columns,
      types: columns.map(() => "text"),
      rowCount: sample.length,
      sample,
    };
  }

  function renderPanel(
    node: DataflowNode,
    result: DataflowNodeResult,
    lastRunMode: "preview" | "full",
    outputs: DataflowRunResult["outputs"] = [],
  ): void {
    render(
      createElement(ResultsPanel, {
        node,
        result,
        nodeStatus: "ok",
        lastRunMode,
        outputs,
        collapsed: false,
        onToggleCollapse: () => {},
      }),
    );
  }

  it("excel_out 预览：sheet: 锚点渲染样本表并标注拟写入 Sheet，不再显示占位", () => {
    renderPanel(
      outNode("excel_out"),
      {
        status: "ok",
        rows: 2,
        ms: 10,
        messages: [],
        stats: [],
        anchors: { "sheet:CSV输入": anchorOf(["金额"], [[1], [2]]) },
      },
      "preview",
    );
    expect(screen.getByText("拟写入 Sheet：CSV输入")).toBeTruthy();
    expect(screen.getByText("金额")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.queryByText("预览模式：未写入文件。")).toBeNull();
  });

  it("csv_out 预览：file: 锚点渲染样本表并标注拟写入文件", () => {
    renderPanel(
      outNode("csv_out"),
      {
        status: "ok",
        rows: 2,
        ms: 10,
        messages: [],
        stats: [],
        anchors: { "file:明细_2026.csv": anchorOf(["客商名称"], [["汇金贸易有限公司"], ["华信贸易有限公司"]]) },
      },
      "preview",
    );
    expect(screen.getByText("拟写入文件：明细_2026.csv")).toBeTruthy();
    expect(screen.getByText("客商名称")).toBeTruthy();
    expect(screen.getByText("汇金贸易有限公司")).toBeTruthy();
    expect(screen.queryByText("预览模式：未写入文件。")).toBeNull();
  });

  it("excel_out 多上游：每个 sheet: 锚点各展示一块样本", () => {
    renderPanel(
      outNode("excel_out"),
      {
        status: "ok",
        rows: 2,
        ms: 10,
        messages: [],
        stats: [],
        anchors: {
          "sheet:筛选通过": anchorOf(["金额"], [[500000]]),
          "sheet:原始序时账": anchorOf(["凭证号"], [["记-0012"]]),
        },
      },
      "preview",
    );
    expect(screen.getByText("拟写入 Sheet：筛选通过")).toBeTruthy();
    expect(screen.getByText("拟写入 Sheet：原始序时账")).toBeTruthy();
    expect(screen.getByText("500,000")).toBeTruthy();
    expect(screen.getByText("记-0012")).toBeTruthy();
  });

  it("无 sheet:/file: 锚点但返回了其他键（如旧演示 output 键）时明示键不一致，不静默占位", () => {
    renderPanel(
      outNode("excel_out"),
      {
        status: "ok",
        rows: 1,
        ms: 10,
        messages: [],
        stats: [],
        anchors: { output: anchorOf(["金额"], [[1]]) },
      },
      "preview",
    );
    const warn = screen.getByText(/与界面预期（sheet:名 \/ file:名）不一致/);
    expect(warn.textContent).toContain("output");
    expect(screen.queryByText("金额")).toBeNull();
    expect(screen.queryByText("预览模式：未写入文件。")).toBeNull();
  });

  it("预览且完全无锚点时仍显示占位", () => {
    renderPanel(
      outNode("excel_out"),
      { status: "ok", rows: 0, ms: 10, messages: [], stats: [], anchors: {} },
      "preview",
    );
    expect(screen.getByText("预览模式：未写入文件。")).toBeTruthy();
  });

  it("全量运行已写入文件：仍展示写入文件清单，样本预览让位", () => {
    renderPanel(
      outNode("excel_out"),
      {
        status: "ok",
        rows: 120,
        ms: 500,
        messages: [],
        stats: [],
        anchors: { "sheet:CSV输入": anchorOf(["金额"], [[1]]) },
      },
      "full",
      [{ nodeId: "out1", path: "D:\\审计输出\\结果.xlsx", sheet: "CSV输入", rows: 120 }],
    );
    expect(screen.getByText("写入文件")).toBeTruthy();
    expect(screen.getByText("D:\\审计输出\\结果.xlsx")).toBeTruthy();
    expect(screen.queryByText("拟写入 Sheet：CSV输入")).toBeNull();
  });

  it("演示引擎 excel_out 预览锚点键与真实引擎一致：sheet:上游节点名（缺省规则）", () => {
    const workflow = sampleWorkflow(); // n3「筛大额」—T→ n4 excel_out（未配 Sheet 名）
    const preview = dataflowDemoResult("preview", workflow);
    const excelOut = preview.nodes.n4;
    expect(Object.keys(excelOut.anchors)).toEqual(["sheet:筛大额"]);
    expect(excelOut.anchors["sheet:筛大额"]?.sample.length).toBeGreaterThan(0);
    expect(excelOut.anchors.output).toBeUndefined();
  });

  it("演示引擎：配置 Sheet 名优先于上游节点名", () => {
    const workflow = sampleWorkflow();
    workflow.nodes[3].config = { ...workflow.nodes[3].config, sheetName: "大额清单" };
    const preview = dataflowDemoResult("preview", workflow);
    expect(Object.keys(preview.nodes.n4.anchors)).toEqual(["sheet:大额清单"]);
  });

  it("演示引擎 csv_out 预览锚点键与真实引擎一致：file:解析后的文件名（参数已替换）", () => {
    const workflow = createEmptyWorkflow("csv 输出演示");
    workflow.params = [{ id: "p1", name: "期间", type: "text", value: "2026" }];
    workflow.nodes = [
      { id: "c1", type: "csv_in", name: "明细输入", x: 0, y: 0, config: defaultConfigFor("csv_in") },
      {
        id: "c2",
        type: "csv_out",
        name: "输出明细",
        x: 300,
        y: 0,
        config: { ...defaultConfigFor("csv_out"), fileName: "明细_{p1}.csv" },
      },
    ];
    workflow.edges = [{ from: "c1", fromAnchor: "output", to: "c2", toAnchor: "in" }];
    const preview = dataflowDemoResult("preview", workflow);
    expect(Object.keys(preview.nodes.c2.anchors)).toEqual(["file:明细_2026.csv"]);
    expect(preview.nodes.c2.anchors["file:明细_2026.csv"]?.sample.length).toBeGreaterThan(0);
  });
});

// ===== 打开含未知节点类型的流程：占位显示而非静默消失 =====
// parseWorkflowFile（model.ts）对未知 type 原样保留、版本门禁只拦 version 不匹配，
// 新版本工具保存/手工编辑的文件（version 仍为 1）打开后，未知类型节点此前在画布上
// 整个不渲染、连线一并消失，状态栏计数却含它们，运行报「节点类型未实现」时无从
// 定位——这里防回归：占位灰块＋顶部明示＋虚线连线。

describe("数据流：未知节点类型打开后占位显示而非静默消失", () => {
  afterEach(() => cleanup());

  function unknownTypeWorkflow(): DataflowWorkflow {
    const workflow = createEmptyWorkflow("含未知类型");
    workflow.nodes = [
      { id: "n1", type: "excel_in", name: "全年序时账", x: 0, y: 0, config: defaultConfigFor("excel_in") },
      { id: "n2", type: "vector_db_in", name: "向量库输入", x: 300, y: 0, config: {} },
      { id: "n3", type: "filter_n", name: "筛大额", x: 600, y: 0, config: defaultConfigFor("filter_n") },
    ];
    workflow.edges = [
      { from: "n1", fromAnchor: "output", to: "n2", toAnchor: "in" }, // 已知 → 未知
      { from: "n2", fromAnchor: "output", to: "n3", toAnchor: "in" }, // 未知 → 已知
      { from: "n1", fromAnchor: "output", to: "nX", toAnchor: "in" }, // 悬空：目标不存在，仍不渲染
    ];
    return workflow;
  }

  function renderCanvas(
    workflow: DataflowWorkflow,
    statusOf: (nodeId: string) => NodeRunStatus = () => "idle",
  ) {
    return render(
      createElement(DataflowCanvas, {
        workflow,
        selection: null,
        statusOf,
        resultOf: () => undefined,
        onSelect: () => {},
        onMoveNode: () => {},
        onNodeDragStart: () => {},
        onConnect: () => {},
      }),
    );
  }

  it("未知类型节点渲染灰色占位块（名称＋类型），已知节点不受影响", () => {
    const view = renderCanvas(unknownTypeWorkflow());
    const placeholder = view.container.querySelector(".df-node-unknown");
    expect(placeholder).toBeTruthy();
    expect(placeholder?.getAttribute("data-id")).toBe("n2");
    expect(screen.getByText("向量库输入")).toBeTruthy();
    expect(screen.getByText("未知类型：vector_db_in")).toBeTruthy();
    expect(screen.getByText("全年序时账")).toBeTruthy();
    expect(screen.getByText("筛大额")).toBeTruthy();
    // 占位块也是 .df-node：三个节点全部渲染，与状态栏计数一致。
    expect(view.container.querySelectorAll(".df-node")).toHaveLength(3);
  });

  it("画布顶部明示不支持的节点数量与类型", () => {
    renderCanvas(unknownTypeWorkflow());
    const banner = screen.getByText(/1 个节点类型当前版本不支持/);
    expect(banner.textContent).toContain("vector_db_in");
    expect(banner.textContent).toContain("占位");
  });

  it("同一未知类型多个节点按类型去重列出", () => {
    const workflow = createEmptyWorkflow("两个未知");
    workflow.nodes = [
      { id: "u1", type: "future_node", name: "甲", x: 0, y: 0, config: {} },
      { id: "u2", type: "future_node", name: "乙", x: 300, y: 0, config: {} },
    ];
    workflow.edges = [];
    renderCanvas(workflow);
    const banner = screen.getByText(/2 个节点类型当前版本不支持/);
    expect(banner.textContent).toContain("future_node");
    expect(banner.textContent?.match(/future_node/g)?.length).toBe(1);
  });

  it("连接占位块的连线以虚线渲染（拓扑可见），悬空连线仍隐藏", () => {
    const view = renderCanvas(unknownTypeWorkflow());
    const edges = view.container.querySelectorAll(".df-edge");
    expect(edges).toHaveLength(2); // 第三条指向不存在的 nX，仍不渲染
    expect(view.container.querySelectorAll(".df-edge-unknown")).toHaveLength(2);
    expect(edges[0].getAttribute("stroke-dasharray")).toBe("6 4");
  });

  it("运行报错后占位块显示错误状态与「类型未实现」角标，可定位出错节点", () => {
    renderCanvas(unknownTypeWorkflow(), (id) => (id === "n2" ? "error" : "idle"));
    const placeholder = document.querySelector(".df-node-unknown");
    expect(placeholder?.className).toContain("df-st-err");
    expect(screen.getByText("类型未实现")).toBeTruthy();
  });
});

// ===== F14：引擎响应契约双防线 =====
// 此前：DataflowRunResultSchema 对 anchors 键名零约束（z.record(z.string(),…)），
// 7 处 .catch() 把结构不符静默吞成空值，结果区只显示「样本数据为空。」；
// 测试又用前端自己的 schema 校验前端自己的演示数据（同源自证）。
// 这里补两道防线：①按 Rust 契约固化的引擎真实形态 fixture（双断言：严格
// schema.parse＋ResultsPanel 渲染）；②锚点键按节点类型白名单收紧
// （anchorKeyMismatch），对演示数据逐节点断言契约相符。

describe("数据流：引擎响应契约 fixture 与锚点键白名单", () => {
  afterEach(() => cleanup());

  const anchorOf = (
    columns: string[],
    sample: (string | number | boolean | null)[][],
  ): DataflowAnchorResult => ({
    columns,
    types: columns.map(() => "text"),
    rowCount: sample.length,
    sample,
  });

  // 引擎真实响应形态，手工按 Rust 契约固化（无法在本组文件范围内改 Rust 加打印，
  // 逐字段出处：顶层 mode/nodes/outputs/error＝engine.rs:299-304；节点
  // status/rows/ms/messages/stats/anchors＝engine.rs:505-513；锚点
  // columns/types/rowCount/sample＝engine.rs:497-502（types 取值
  // text/integer/decimal/date/bool＝value.rs:351-358）；输入节点锚点键
  // "output"＝input.rs:722；输出节点锚点键 sheet:名＝output.rs:318。
  // 场景对照 Rust 测试 preview_does_not_write_output_files（engine.rs:947-968）：
  // csv_in「CSV输入」读 "金额\n1\n2\n" → excel_out「Excel输出」fileName＝结果.xlsx
  // （未配 sheetName → sheet 基名＝上游节点名「CSV输入」），断言过 outputs 长度 0、
  // out 节点 ok、row_count(out,"sheet:CSV输入")＝2。ms/消息文案为代表性取值，
  // 结构与锚点键为契约断言对象。
  const enginePreviewFixture = {
    mode: "preview",
    nodes: {
      in: {
        status: "ok",
        rows: 2,
        ms: 3,
        messages: ["读取 1 个文件：in.csv"],
        stats: ["读取行数 2"],
        anchors: {
          output: { columns: ["金额"], types: ["integer"], rowCount: 2, sample: [[1], [2]] },
        },
      },
      out: {
        status: "ok",
        rows: 2,
        ms: 1,
        messages: ["预览模式：未写入输出文件。"],
        stats: ["拟写入 Sheet：CSV输入", "拟写入数据行数：2"],
        anchors: {
          "sheet:CSV输入": {
            columns: ["金额"],
            types: ["integer"],
            rowCount: 2,
            sample: [[1], [2]],
          },
        },
      },
    },
    outputs: [],
    error: null,
  } satisfies DataflowRunResult;

  it("引擎真实形态 fixture 通过宽松与严格（无 catch 兜底）双重 schema 校验", () => {
    expect(() => DataflowRunResultSchema.parse(enginePreviewFixture)).not.toThrow();
    // 严格版无任何 .catch()：真实引擎形态不该触发降级，一旦解析失败即契约漂移。
    expect(() => DataflowRunResultStrictSchema.parse(enginePreviewFixture)).not.toThrow();
  });

  it("fixture 锚点键按节点类型通过白名单（输入 output、输出 sheet:名）", () => {
    expect(anchorKeyMismatch("csv_in", ["output"])).toBeNull();
    expect(anchorKeyMismatch("excel_out", ["sheet:CSV输入"])).toBeNull();
  });

  it("fixture 在 ResultsPanel 双断言：输入节点样本表＋输出节点写入样本均可渲染", () => {
    // 输入节点：输出数据页签按 output 键展示样本。
    renderPanelFor(enginePreviewFixture, "in", "csv_in", "CSV输入");
    expect(screen.getByText("金额")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.queryByText(/样本数据为空/)).toBeNull();
    cleanup();
    // 输出节点：写入结果页签按 sheet: 键展示样本（F4 修复的渲染路径）。
    renderPanelFor(enginePreviewFixture, "out", "excel_out", "Excel输出");
    expect(screen.getByText("拟写入 Sheet：CSV输入")).toBeTruthy();
    expect(screen.getByText("金额")).toBeTruthy();
  });

  it("锚点键白名单拦下历史错位形态（out/output 用在输出或普通节点上）", () => {
    // 2026-10-28：输出节点收到 out；F4：输出节点收到 output。
    expect(anchorKeyMismatch("excel_out", ["out"])?.unexpected).toEqual(["out"]);
    expect(anchorKeyMismatch("excel_out", ["output"])?.unexpected).toEqual(["output"]);
    expect(anchorKeyMismatch("csv_out", ["file:明细.csv", "output"])?.unexpected).toEqual(["output"]);
    // 普通节点收到引擎旧的 out 键（2026-10-28 修的 nodeSpec 侧）同样被拦。
    expect(anchorKeyMismatch("filter_n", ["out"])?.unexpected).toEqual(["out"]);
    expect(anchorKeyMismatch("filter_n", ["output"])?.unexpected).toEqual(["output"]);
    // 契约相符与子集形态放行；未知类型与空锚点无法判定（null）。
    expect(anchorKeyMismatch("filter_n", ["T", "F"])).toBeNull();
    expect(anchorKeyMismatch("filter_n", ["T"])).toBeNull();
    expect(anchorKeyMismatch("join_n", ["J", "L", "R"])).toBeNull();
    expect(anchorKeyMismatch("future_node", ["anything"])).toBeNull();
    expect(anchorKeyMismatch("excel_out", [])).toBeNull();
  });

  it("演示数据（预览＋全量）逐节点通过锚点键白名单，不再同源自证", () => {
    const workflow = sampleWorkflow();
    for (const mode of ["preview", "full"] as const) {
      const result = dataflowDemoResult(mode, workflow);
      for (const node of workflow.nodes) {
        const nodeResult = result.nodes[node.id];
        if (!nodeResult || nodeResult.status === "error") continue;
        const mismatch = anchorKeyMismatch(node.type, Object.keys(nodeResult.anchors));
        expect(mismatch).toBeNull();
      }
    }
  });

  it("演示数据（预览＋全量）通过严格 schema：不依赖任何 catch 降级", () => {
    const workflow = sampleWorkflow();
    expect(() =>
      DataflowRunResultStrictSchema.parse(dataflowDemoResult("preview", workflow)),
    ).not.toThrow();
    expect(() =>
      DataflowRunResultStrictSchema.parse(dataflowDemoResult("full", workflow, { p1: "2027" })),
    ).not.toThrow();
  });

  it("数据页签键不一致时明示版本不兼容，而非「样本数据为空。」", () => {
    renderPanelFor(
      {
        mode: "preview",
        nodes: {
          n1: {
            status: "ok",
            rows: 2,
            ms: 5,
            messages: [],
            stats: [],
            // 引擎若回退旧键 out：页签按 spec 找 T/F 找不到。
            anchors: { out: anchorOf(["金额"], [[1], [2]]) },
          },
        },
        outputs: [],
        error: null,
      },
      "n1",
      "filter_n",
      "筛大额",
    );
    const warn = screen.getByText(/输出键未在引擎返回中找到/);
    expect(warn.textContent).toContain("out");
    expect(warn.textContent).toContain("T、F");
    expect(screen.queryByText(/样本数据为空/)).toBeNull();
  });

  it("锚点存在且样本确为空时仍显示「样本数据为空。」（真实空样本不误报）", () => {
    renderPanelFor(
      {
        mode: "preview",
        nodes: {
          n1: {
            status: "ok",
            rows: 0,
            ms: 5,
            messages: [],
            stats: [],
            anchors: { T: { columns: ["金额"], types: ["integer"], rowCount: 0, sample: [] } },
          },
        },
        outputs: [],
        error: null,
      },
      "n1",
      "filter_n",
      "筛大额",
    );
    expect(screen.getByText("样本数据为空。")).toBeTruthy();
    expect(screen.queryByText(/输出键未在引擎返回中找到/)).toBeNull();
  });

  /** 用整个 run result 中的单节点渲染 ResultsPanel（走与页面一致的 props 形态）。 */
  function renderPanelFor(
    run: DataflowRunResult,
    nodeId: string,
    type: string,
    name: string,
  ): void {
    const parsed = DataflowRunResultSchema.parse(run);
    render(
      createElement(ResultsPanel, {
        node: { id: nodeId, type, name, x: 0, y: 0, config: defaultConfigFor(type) },
        result: parsed.nodes[nodeId],
        nodeStatus: "ok",
        lastRunMode: parsed.mode,
        outputs: parsed.outputs,
        collapsed: false,
        onToggleCollapse: () => {},
      }),
    );
  }
});

// ===== F25：全量运行后输出节点的「写入文件」表格（浏览器演示模式） =====
// 此前 UI 测试只点过「预览运行」，输出清单（写入文件/Sheet/行数三列，
// csv_out 空 sheet 显示「—」）这条呈现路径零覆盖——这里补整页组件测试：
// 草稿恢复 输入→筛选→excel_out/csv_out 双输出流程，点「全量运行」，
// 分别选中两个输出节点断言写入表格与完成横幅。

describe("数据流：全量运行后输出节点显示写入文件表格", () => {
  const dataflowTool: ToolManifest = {
    id: "dataflow",
    name: "数据流 DataFlow",
    description: "可视化数据处理工作流",
    route: "/tools/dataflow",
    version: "1.0",
    capabilities: ["preview", "run", "save", "open"],
    migrationStatus: "preview",
  };

  beforeEach(() => {
    // 运行前输出文件名解析需要「输出位置」：预置记住值，模拟用户已选过一次。
    window.localStorage.setItem("audit-toolbox:dataflow:output-dir", "D:\\审计输出");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  function twoOutputFlow(): DataflowWorkflow {
    const workflow = createEmptyWorkflow("全量双输出演示");
    workflow.nodes = [
      { id: "n1", type: "excel_in", name: "全年序时账", x: 60, y: 80, config: defaultConfigFor("excel_in") },
      { id: "n2", type: "filter_n", name: "筛大额", x: 300, y: 80, config: {
        // 运行前自检会拦下空字段/空值的条件行（见 DataFlowRunError.test），
        // 这里按节点名补一条完整的大额条件。
        condition: { op: "and", rules: [{ field: "金额", operator: ">", value: "0" }] },
      } },
      {
        id: "n3",
        type: "excel_out",
        name: "输出·大额清单",
        x: 540,
        y: 40,
        config: { ...defaultConfigFor("excel_out"), fileName: "大额清单.xlsx" },
      },
      {
        id: "n4",
        type: "csv_out",
        name: "输出·明细",
        x: 540,
        y: 220,
        config: { ...defaultConfigFor("csv_out"), fileName: "明细.csv" },
      },
    ];
    workflow.edges = [
      { from: "n1", fromAnchor: "output", to: "n2", toAnchor: "in" },
      { from: "n2", fromAnchor: "T", to: "n3", toAnchor: "in" },
      { from: "n2", fromAnchor: "F", to: "n4", toAnchor: "in" },
    ];
    return workflow;
  }

  function selectNode(name: string): void {
    fireEvent.click(screen.getByText(name, { selector: ".df-node-names b" }).closest(".df-node") as HTMLElement);
  }

  /** 结果区范围限定：画布上同名节点（如 Sheet 名＝上游节点名「筛大额」）会与
   *  表格文案撞名，断言都收在 .df-results 内做精确匹配。 */
  function resultsArea(): HTMLElement {
    return document.querySelector(".df-results") as HTMLElement;
  }

  it("点「全量运行」后选中 excel_out：三列写入表＋Sheet 名＋完成横幅", async () => {
    const workflow = twoOutputFlow();
    saveDraft(workflow);
    render(createElement(DataFlowPage, { tool: dataflowTool }));
    // 草稿自动恢复（无弹窗），画布出现流程节点。
    await screen.findByText("输出·大额清单", { selector: ".df-node-names b" });
    fireEvent.click(screen.getByRole("button", { name: /全量运行/ }));
    const banner = await screen.findByText(/全量运行完成 · 输出已写入文件/, undefined, { timeout: 4000 });
    expect(banner.textContent).toContain("详见输出节点与消息页签");

    // 演示引擎与页面用同一确定性函数生成结果：行数取自 demo 输出，避免按 seq 硬编码。
    const demo = dataflowDemoResult("full", workflow);
    const excelEntry = demo.outputs.find((item) => item.nodeId === "n3");
    expect(excelEntry).toBeTruthy();

    selectNode("输出·大额清单");
    await waitFor(() => expect(screen.getByText("写入文件")).toBeTruthy());
    const results = resultsArea();
    expect(within(results).getByText("写入文件")).toBeTruthy();
    expect(within(results).getByText("Sheet")).toBeTruthy();
    expect(within(results).getByText("行数")).toBeTruthy();
    expect(within(results).getByText("D:\\审计输出\\大额清单.xlsx")).toBeTruthy();
    // excel_out 的 Sheet 缺省＝上游节点名（与引擎 sheet: 键一致）。
    expect(within(results).getByText("筛大额")).toBeTruthy();
    expect(within(results).getByText((excelEntry?.rows ?? 0).toLocaleString("zh-CN"))).toBeTruthy();
  });

  it("选中 csv_out：写入表显示文件路径与「—」（无 Sheet），行数千分位格式化", async () => {
    const workflow = twoOutputFlow();
    saveDraft(workflow);
    render(createElement(DataFlowPage, { tool: dataflowTool }));
    await screen.findByText("输出·明细", { selector: ".df-node-names b" });
    fireEvent.click(screen.getByRole("button", { name: /全量运行/ }));
    await screen.findByText(/全量运行完成 · 输出已写入文件/, undefined, { timeout: 4000 });

    const demo = dataflowDemoResult("full", workflow);
    const csvEntry = demo.outputs.find((item) => item.nodeId === "n4");
    expect(csvEntry).toBeTruthy();

    selectNode("输出·明细");
    await waitFor(() => expect(screen.getByText("写入文件")).toBeTruthy());
    const results = resultsArea();
    expect(within(results).getByText("D:\\审计输出\\明细.csv")).toBeTruthy();
    // csv_out 不写 Sheet：空值显示「—」而不是空白。
    expect(within(results).getByText("—")).toBeTruthy();
    expect(within(results).getByText((csvEntry?.rows ?? 0).toLocaleString("zh-CN"))).toBeTruthy();
  });

  it("行数千分位：大行数按 zh-CN 分组显示（2,847,301）", () => {
    // 演示数据的输出行数恒小于 1,000，千分位路径用直接渲染 ResultsPanel 覆盖。
    render(
      createElement(ResultsPanel, {
        node: {
          id: "out1",
          type: "excel_out",
          name: "输出·全量",
          x: 0,
          y: 0,
          config: defaultConfigFor("excel_out"),
        },
        result: {
          status: "ok",
          rows: 2847301,
          ms: 400,
          messages: [],
          stats: [],
          anchors: {},
        },
        nodeStatus: "ok",
        lastRunMode: "full",
        outputs: [{ nodeId: "out1", path: "D:\\审计输出\\全量.xlsx", sheet: "序时账", rows: 2847301 }],
        collapsed: false,
        onToggleCollapse: () => {},
      }),
    );
    expect(screen.getByText("写入文件")).toBeTruthy();
    expect(screen.getByText("2,847,301")).toBeTruthy();
    expect(screen.queryByText("2847301")).toBeNull();
  });
});

describe("输出文件名解析（留空自动命名、纯名字进输出位置）", () => {
  it("留空＝流程名_节点名_时间戳；纯名字＝进输出位置并补扩展名；完整路径原样；不改用户配置", () => {
    const wf = createEmptyWorkflow("底稿流程");
    wf.nodes = [
      { id: "n1", type: "excel_out", name: "大额清单", x: 0, y: 0, config: { fileName: "" } },
      { id: "n2", type: "csv_out", name: "明细", x: 0, y: 0, config: { fileName: "123" } },
      { id: "n3", type: "excel_out", name: "手填", x: 0, y: 0, config: { fileName: "D:\\x\\y.xlsx" } },
    ];
    const resolved = resolveOutputPaths(wf, "D:\\审计底稿");
    expect(resolved.needsDir).toBe(false);
    const [n1, n2, n3] = resolved.workflow.nodes;
    expect(String((n1!.config as Record<string, unknown>).fileName)).toMatch(
      /^D:\\审计底稿\\底稿流程_大额清单_\d{8}_\d{6}\.xlsx$/,
    );
    expect((n2!.config as Record<string, unknown>).fileName).toBe("D:\\审计底稿\\123.csv");
    expect((n3!.config as Record<string, unknown>).fileName).toBe("D:\\x\\y.xlsx");
    // 解析只用于本次运行：用户留在配置里的原文不被改写。
    expect((wf.nodes[0]!.config as Record<string, unknown>).fileName).toBe("");
    expect(resolved.notes.length).toBe(2);
  });

  it("输出位置未设置且有输出节点时报告 needsDir，由页面引导用户选一次", () => {
    const wf = createEmptyWorkflow("流程");
    wf.nodes = [{ id: "n1", type: "csv_out", name: "输出", x: 0, y: 0, config: { fileName: "a.csv" } }];
    const resolved = resolveOutputPaths(wf, "");
    expect(resolved.needsDir).toBe(true);
    expect(resolved.workflow.nodes[0]).toBe(wf.nodes[0]);
  });
});
