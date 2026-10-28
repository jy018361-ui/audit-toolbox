// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  DATAFLOW_AVAILABLE_TYPES,
  DATAFLOW_CATEGORIES,
  DATAFLOW_NODE_SPECS,
  anchorAcceptsMultiple,
  nodeSpec,
} from "./nodeSpecs";
import {
  DataflowRunResultSchema,
  WorkflowHistory,
  applyParamPlaceholders,
  configKeysWithinContract,
  createEmptyWorkflow,
  dataflowRunRequest,
  defaultCheckRule,
  defaultConfigFor,
  normalizeCheckRule,
  normalizeConfig,
  parseWorkflowFile,
  removeDraft,
  saveDraft,
  listDrafts,
  serializeWorkflow,
  validateNewEdge,
  type DataflowWorkflow,
} from "./model";
import { dataflowDemoResult } from "./demoData";

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
      split: { field: "科目编码", mode: "width", delimiter: "", widths: [4, 4], keepOriginal: true, columnPrefix: "段" },
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
    // 未知节点 id 时全部执行（不截断）。
    expect(Object.keys(dataflowDemoResult("full", workflow, {}, "nX").nodes)).toHaveLength(4);
  });
});
