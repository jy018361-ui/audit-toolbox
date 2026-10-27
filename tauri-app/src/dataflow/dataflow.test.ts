// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  DATAFLOW_PHASE1_TYPES,
  DATAFLOW_CATEGORIES,
  DATAFLOW_NODE_SPECS,
  nodeSpec,
} from "./nodeSpecs";
import {
  DataflowRunResultSchema,
  WorkflowHistory,
  applyParamPlaceholders,
  configKeysWithinContract,
  createEmptyWorkflow,
  defaultConfigFor,
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
    { from: "n1", fromAnchor: "out", to: "n2", toAnchor: "in" },
    { from: "n2", fromAnchor: "out", to: "n3", toAnchor: "in" },
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
      fromAnchor: "out",
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
      fromAnchor: "out",
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
      fromAnchor: "out",
      to: "n2",
      toAnchor: "in",
    });
    expect(check.ok).toBe(false);
  });

  it("单输入口被占用后拒绝再接入", () => {
    const check = validateNewEdge(workflow, {
      from: "n1",
      fromAnchor: "out",
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
      edges: [{ from: "n2", fromAnchor: "out", to: "n3", toAnchor: "in" }],
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
      fromAnchor: "out",
      to: "n4",
      toAnchor: "in",
    });
    expect(second.ok).toBe(true);
  });
});

describe("数据流：8 节点目录完整性", () => {
  it("第一期恰好是约定的 8 个节点", () => {
    const phase1 = DATAFLOW_NODE_SPECS.filter((spec) => !spec.phase2).map((spec) => spec.type);
    expect(phase1.sort()).toEqual([...DATAFLOW_PHASE1_TYPES].sort());
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

  it("第一期节点锚点齐备：筛选 T/F 双路，输出节点无输出口", () => {
    const filter = nodeSpec("filter_n");
    expect(filter?.outputs.map((anchor) => anchor.key)).toEqual(["T", "F"]);
    expect(nodeSpec("excel_out")?.outputs).toEqual([]);
    expect(nodeSpec("csv_out")?.outputs).toEqual([]);
    for (const type of DATAFLOW_PHASE1_TYPES) {
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

  it("全部第一期节点默认 config 只含契约内字段", () => {
    for (const type of DATAFLOW_PHASE1_TYPES) {
      expect(configKeysWithinContract(type, defaultConfigFor(type)), type).toBe(true);
      expect(
        configKeysWithinContract(type, { ...defaultConfigFor(type), 额外字段: 1 }),
        type,
      ).toBe(false);
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
    expect(preview.nodes[workflow.nodes[0].id].anchors.out.columns).toContain("凭证号");

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
});
