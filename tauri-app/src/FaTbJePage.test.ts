import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  faAssignmentsForEntities,
  faAssignmentsForEntityAccounts,
  faReviewEntityAccounts,
  faTbJeMissingMappings,
  groupAssignmentViews,
  normalizeFaCategory,
  splitFaAccount,
  suggestFaAccount,
  suggestFaAccounts,
  unionEntityAccounts,
} from "./FaTbJePage";

describe("FA TB+JE account role presets", () => {
  it("suggests roles without creating an independent ledger dictionary", () => {
    expect(suggestFaAccount("1601 固定资产-机器设备")).toEqual({
      account: "1601 固定资产-机器设备",
      role: "cost",
      category: "机器设备",
    });
    expect(suggestFaAccount("1602 累计折旧-机器设备")).toEqual({
      account: "1602 累计折旧-机器设备",
      role: "depreciation",
      category: "机器设备",
    });
    expect(suggestFaAccount("2202 应付账款").role).toBe("excluded");
  });

  it("拆科目串时不把纯英文名的首个单词当编码", () => {
    expect(splitFaAccount("16020002 机械设备")).toEqual({
      code: "16020002",
      name: "机械设备",
    });
    expect(splitFaAccount("16010004-数据处理设备")).toEqual({
      code: "16010004",
      name: "数据处理设备",
    });
    expect(splitFaAccount("1602")).toEqual({ code: "1602", name: "" });
    expect(splitFaAccount("01-1401-000-000-000 固定资产-厂房 FA - Buildings")).toEqual({
      code: "01-1401-000-000-000",
      name: "固定资产-厂房 FA - Buildings",
    });
    expect(splitFaAccount("01-1001-000-000-000")).toEqual({
      code: "01-1001-000-000-000",
      name: "",
    });
    // SAP 型余额表把编码拼在串尾
    expect(
      splitFaAccount("固定资产 固定资产-累计折旧-办公设备 1601130001"),
    ).toEqual({
      code: "1601130001",
      name: "固定资产 固定资产-累计折旧-办公设备",
    });
    expect(splitFaAccount("Accumulated Depreciation")).toEqual({
      code: "",
      name: "Accumulated Depreciation",
    });
  });

  it("下级科目跟着上级科目走，不再按名称各判各的", () => {
    // 真实样例：1602 累计折旧下面挂着「机械设备」「数据处理设备」，
    // 只看名称会整片判成原值。
    const chart = [
      "1601 固定资产",
      "16010004 数据处理设备",
      "1602 累计折旧",
      "16020002 机械设备",
      "16020004 数据处理设备",
      "1604 在建工程",
      "16040003 数据处理设备",
      "1606 固定资产清理",
      "5301 研发支出",
      "5301000125 直接投入-仪器设备维护费",
      "5301000128 直接投入-房屋租赁费",
    ];
    expect(
      Object.fromEntries(
        suggestFaAccounts(chart).map((item) => [item.account, item.role]),
      ),
    ).toEqual({
      "1601 固定资产": "cost",
      "16010004 数据处理设备": "cost",
      "1602 累计折旧": "depreciation",
      "16020002 机械设备": "depreciation",
      "16020004 数据处理设备": "depreciation",
      "1604 在建工程": "excluded",
      "16040003 数据处理设备": "excluded",
      "1606 固定资产清理": "excluded",
      "5301 研发支出": "excluded",
      "5301000125 直接投入-仪器设备维护费": "excluded",
      "5301000128 直接投入-房屋租赁费": "excluded",
    });
    // 原值与折旧按同名类别配对，汇总变动表才能对上。
    expect(
      suggestFaAccounts(chart)
        .filter((item) => item.role !== "excluded")
        .map((item) => item.category),
    ).toEqual([
      "固定资产",
      "数据处理设备",
      "固定资产",
      "机械设备",
      "数据处理设备",
    ]);
  });

  it("SAP 型科目表：编码在串尾、累计折旧挂在 1601 下、损益类科目不进原值", () => {
    // 4800 真实样例。余额表列序是「名称一级 名称二级 代码」，编码落在最后；
    // 累计折旧不在 1602 而是 1601 的子科目；6601 是损益类折旧费用，
    // 名称里带「固定资产」「设备」，只看名称会被当成原值捞进来。
    const chart = [
      "固定资产 固定资产-办公设备 1601030001",
      "固定资产 固定资产-计算机及硬件设备 1601040001",
      "固定资产 固定资产-机器设备 1601050002",
      "固定资产 固定资产-累计折旧-办公设备 1601130001",
      "固定资产 固定资产-累计折旧-计算机及硬件设备 1601140001",
      "固定资产 固定资产-累计折旧-机器设备 1601150002",
      "使用权资产 使用权资产-原值 1605010001",
      "使用权资产 减：使用权资产-累计折旧 1605110001",
      "运营费用 运营费用-折旧费-固定资产 6601090401",
      "运营费用 运营费用-设备租赁费 6601330001",
    ];
    expect(
      suggestFaAccounts(chart).map((item) => [item.role, item.category]),
    ).toEqual([
      ["cost", "办公设备"],
      ["cost", "计算机及硬件设备"],
      ["cost", "机器设备"],
      ["depreciation", "办公设备"],
      ["depreciation", "计算机及硬件设备"],
      ["depreciation", "机器设备"],
      ["excluded", "使用权资产 使用权资产-原值"],
      ["excluded", "使用权资产 减：使用权资产"],
      ["excluded", "运营费用 运营费用-折旧费"],
      ["excluded", "运营费用 运营费用-设备租赁费"],
    ]);
  });

  it("TBJEPBC 样例：名称带资产字样的非固定资产科目与编码残留的类别", () => {
    // 02 号样例：银行存款户名带「房屋积金」——宽词（房屋／设备）不参与
    // 非标准编码的进表判断，只有明确写出「固定资产」才算。
    expect(
      suggestFaAccount("1002016871 银行存款-汉口银行硚口支行(房屋积金)6").role,
    ).toBe("excluded");
    // 10 号样例：自定义 1642 使用权资产折旧。原值侧不含使用权资产，
    // 折旧侧混入必然勾稽不平。
    expect(suggestFaAccount("1642 使用权资产累计折旧").role).toBe("excluded");
    expect(suggestFaAccount("1642.01 使用权资产折旧-医药港5期租赁").role).toBe(
      "excluded",
    );
    // 05 号样例：SAP 技术性清账科目不是固定资产本体。
    expect(suggestFaAccount("1601999999 固定资产技术性清账科目").role).toBe(
      "excluded",
    );
    // 08 号样例：名称部分自带一份编码（160101\固定资产\房屋建筑物），
    // 类别要剥干净编码与路径分隔，不能显示成「160101\房屋建筑物」。
    expect(
      suggestFaAccount("160101 160101\\固定资产\\房屋建筑物").category,
    ).toBe("房屋建筑物");
    expect(suggestFaAccount("160101 160101\\固定资产\\房屋建筑物").role).toBe(
      "cost",
    );
    expect(suggestFaAccount("160104 固定资产_办公设备及其他").category).toBe(
      "办公设备及其他",
    );
    expect(normalizeFaCategory("_房屋_建筑物")).toBe("房屋建筑物");
  });

  it("同一科目在 TB 与 JE 里拼法不同也归一到同一角色与类别", () => {
    // TB 侧「名称 代码」、JE 侧「代码 名称」，名称取的列还不一样。
    // 不归一的话两条分类会带着不同类别送进引擎，原值与累计折旧永远配不上对。
    const rows = suggestFaAccounts([
      "固定资产 固定资产-机器设备 1601050002",
      "固定资产 固定资产-累计折旧-机器设备 1601150002",
      "1601050002 固定资产-机器设备-检测仪器",
      "1601150002 累计折旧-机器设备-检测仪器",
    ]);
    expect(rows.map((item) => [item.role, item.category])).toEqual([
      ["cost", "机器设备"],
      ["depreciation", "机器设备"],
      ["cost", "机器设备"],
      ["depreciation", "机器设备"],
    ]);
  });

  it("科目表没有上级行时按一级编码兜底", () => {
    expect(
      suggestFaAccounts(["16010004 数据处理设备", "16020004 数据处理设备"]).map(
        (item) => item.role,
      ),
    ).toEqual(["cost", "depreciation"]);
  });

  it("非标准编码账套：自身或上级科目名明确写固定资产/累计折旧才进表", () => {
    // 旧制度 1501/1502 形态：上级「1 资产」无语义，靠自身名称进表，
    // 子级沿编码前缀继承；银行存款户名带宽词依旧被挡。
    const chart = [
      "1 资产",
      "1501 固定资产",
      "150101 房屋及建筑物",
      "150102 机械设备",
      "1502 累计折旧",
      "150201 房屋及建筑物",
      "1002 银行存款",
      "1002016871 银行存款-汉口银行(房屋积金)",
    ];
    expect(
      Object.fromEntries(suggestFaAccounts(chart).map((item) => [item.account, item.role])),
    ).toEqual({
      "1 资产": "excluded",
      "1501 固定资产": "cost",
      "150101 房屋及建筑物": "cost",
      "150102 机械设备": "cost",
      "1502 累计折旧": "depreciation",
      "150201 房屋及建筑物": "depreciation",
      "1002 银行存款": "excluded",
      "1002016871 银行存款-汉口银行(房屋积金)": "excluded",
    });
    // 单科目、无上级行可查时：名称明确的进表，宽词的不进。
    expect(suggestFaAccount("1501 固定资产").role).toBe("cost");
    expect(suggestFaAccount("1502 累计折旧").role).toBe("depreciation");
    expect(suggestFaAccount("150101 房屋及建筑物").role).toBe("excluded");
    // 名称含「固定资产」但属费用/清理口径的依旧排除。
    expect(suggestFaAccount("6601090401 折旧费-固定资产").role).toBe("excluded");
    expect(suggestFaAccount("16060001 固定资产清理-设备").role).toBe("excluded");
  });

  it("固定资产科目排在前面，其余科目垫底", () => {
    const rows = faAssignmentsForEntities(
      ["1002 银行存款", "1602 累计折旧", "2202 应付账款", "1601 固定资产"],
      [],
      [],
    );
    expect(rows.map((row) => row.account)).toEqual([
      "1601 固定资产",
      "1602 累计折旧",
      "1002 银行存款",
      "2202 应付账款",
    ]);
  });

  it("keeps the same account code independently classified for each entity", () => {
    const account = "FA01 固定资产";
    const actual = faAssignmentsForEntities(
      [account],
      ["A", "B"],
      [
        { entity: "A", account, role: "cost", category: "机器设备" },
        { entity: "B", account, role: "cost", category: "运输设备" },
      ],
    );
    expect(actual.map((item) => [item.entity, item.category])).toEqual([
      ["A", "机器设备"],
      ["B", "运输设备"],
    ]);
    expect(faAssignmentsForEntities([account], ["C"], actual)[0].entity).toBe(
      "C",
    );
    expect(
      faAssignmentsForEntities([account], ["C"], actual)[0].category,
    ).not.toBe("运输设备");
  });

  it("blocks the next step until TB and JE required roles are mapped", () => {
    expect(faTbJeMissingMappings("tb", {})).toEqual([
      "科目编码或科目名称",
      "期初余额",
      "期末余额",
    ]);
    expect(
      faTbJeMissingMappings("tb", {
        accountCode: "科目编码",
        openingFunctionalDebit: "期初借方",
        openingFunctionalCredit: "期初贷方",
        closingFunctionalAmount: "期末余额",
      }),
    ).toEqual([]);
    expect(
      faTbJeMissingMappings("je", {
        accountName: "科目名称",
        id: ["凭证字", "凭证号"],
        date: "记账日期",
        functionalDebit: "借方金额",
        functionalCredit: "贷方金额",
      }),
    ).toEqual([]);
  });

  it("uses the public default entity when neither ledger has an entity column", () => {
    const rows = faAssignmentsForEntities(
      ["1601 固定资产", "1602 累计折旧"],
      [],
      [],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.entity))).toEqual(
      new Set(["默认主体"]),
    );
    expect(rows.map((row) => [row.role, row.category])).toEqual([
      ["cost", "固定资产"],
      ["depreciation", "固定资产"],
    ]);
  });
});

describe("FA TB+JE 真实主体×科目组合", () => {
  it("科目复核只采用 TB 科目，不把 JE 独有的对方科目带入清单", () => {
    const rows = faReviewEntityAccounts([
      { entity: "默认主体", account: "1601020000 固定资产-房屋" },
    ]);
    const jeOnly = [
      { entity: "默认主体", account: "修理费-房屋建筑物-大修理" },
    ];

    expect(rows).toEqual([
      { entity: "默认主体", account: "1601020000 固定资产-房屋" },
    ]);
    expect(rows).not.toContainEqual(jeOnly[0]);
  });

  it("只有 TB 有主体映射时，复核项使用测算引擎的默认主体", () => {
    const rows = faReviewEntityAccounts([
      { entity: "3000", account: "130010 PP&E - Land 固定资产-土地" },
      { entity: "3000", account: "140000 Accumulated Depreciation 累计折旧" },
    ], false);
    expect(rows.map((row) => row.entity)).toEqual(["默认主体", "默认主体"]);
    expect(faAssignmentsForEntityAccounts(rows, []).map((row) => row.role)).toEqual([
      "cost", "depreciation",
    ]);
  });

  it("分段科目编码不按账套段合并，保留各原值和折旧科目", () => {
    const names = [
      "01-1001-000-000-000 库存现金 Cash on hand",
      "01-1401-000-000-000 固定资产-厂房 FA - Buildings",
      "01-1402-000-000-000 固定资产-机器设备 FA - Machinery",
      "01-1451-000-000-000 累计折旧 Accumulated depreciation",
    ];
    const rows = faAssignmentsForEntityAccounts(
      names.map((account) => ({ entity: "默认主体", account })), [],
    );
    const views = groupAssignmentViews(rows);
    expect(views).toHaveLength(4);
    expect(views.map((view) => view.role)).toEqual([
      "cost", "cost", "depreciation", "excluded",
    ]);
  });

  it("只按账里真实存在的组合铺清单，主体 2000 名下不出现只有 2002 才有的科目", () => {
    const pairs = unionEntityAccounts(
      [
        {
          entity: "2000",
          account: "1601040000 Fixed assets_Transportaion equipment",
        },
        {
          entity: "2000",
          account: "1601020000 Fixed assets_Machinery equipment",
        },
      ],
      [{ entity: "2002", account: "1601020000" }],
    );
    expect(pairs).toHaveLength(3);
    const rows = faAssignmentsForEntityAccounts(pairs, []);
    // 旧笛卡尔积口径下这会是「2 主体 × 3 科目 = 6 行」，其中一半是幻影组合。
    expect(rows).toHaveLength(3);
    const codesUnder2000 = rows
      .filter((row) => row.entity === "2000")
      .map((row) => splitFaAccount(row.account).code);
    expect(codesUnder2000).toEqual(["1601040000", "1601020000"]);
    // 1601020000 在 2000 名下只来自 TB 的带名称写法，2002 名下只有纯编码写法。
    expect(
      rows
        .filter((row) => splitFaAccount(row.account).code === "1601020000")
        .map((row) => row.entity),
    ).toEqual(["2000", "2002"]);
    // 2002 的纯编码写法保留原串，payload 逐条匹配用。
    expect(rows.find((row) => row.entity === "2002")?.account).toBe(
      "1601020000",
    );
  });

  it("同一（主体，编码）的两种写法合并为一行，来源标签 TB+JE，payload 仍含两条原始串", () => {
    const pairs = unionEntityAccounts(
      [
        {
          entity: "2000",
          account: "1601020000 Fixed assets_Machinery equipment",
        },
      ],
      [{ entity: "2000", account: "1601020000" }],
    );
    const rows = faAssignmentsForEntityAccounts(pairs, []);
    // payload 级：两种写法各自成行、缺一不可（引擎按这些串逐侧匹配）。
    expect(rows.map((row) => row.account)).toEqual([
      "1601020000 Fixed assets_Machinery equipment",
      "1601020000",
    ]);
    // 两种写法经自动归一拿到同一角色与类别。
    expect(new Set(rows.map((row) => `${row.role}|${row.category}`))).toEqual(
      new Set(["cost|Fixed assets Machinery equipment"]),
    );
    const views = groupAssignmentViews(rows, (entity, account) =>
      account.includes("Fixed assets") ? ["tb" as const] : ["je" as const],
    );
    expect(views).toHaveLength(1);
    expect(views[0].sources).toEqual(["tb", "je"]);
    expect(views[0].label).toBe("1601020000 Fixed assets_Machinery equipment");
    expect(views[0].accounts).toEqual([
      "1601020000 Fixed assets_Machinery equipment",
      "1601020000",
    ]);
  });

  it("保留用户已确认的角色与类别（按主体＋科目串匹配），排序口径与旧版一致", () => {
    const pairs = unionEntityAccounts(
      [
        { entity: "A", account: "1002 银行存款" },
        { entity: "A", account: "1601 固定资产" },
      ],
      [{ entity: "B", account: "1602 累计折旧" }],
    );
    const rows = faAssignmentsForEntityAccounts(pairs, [
      {
        entity: "A",
        account: "1601 固定资产",
        role: "depreciation",
        category: "机修设备",
      },
    ]);
    expect(rows.map((row) => [row.entity, row.account])).toEqual([
      ["A", "1601 固定资产"],
      ["B", "1602 累计折旧"],
      ["A", "1002 银行存款"],
    ]);
    expect(rows[0]).toEqual({
      entity: "A",
      account: "1601 固定资产",
      role: "depreciation",
      category: "机修设备",
    });
  });

  it("跨主体统一把原值和折旧排在排除科目前面", () => {
    const rows = faAssignmentsForEntityAccounts(
      [
        { entity: "2000", account: "1002 银行存款" },
        { entity: "2000", account: "1601040000 固定资产-运输设备" },
        { entity: "2002", account: "1601020000 固定资产-机器设备" },
        { entity: "2002", account: "1602020000 累计折旧-机器设备" },
      ],
      [],
    );
    expect(rows.map((row) => [row.entity, row.role])).toEqual([
      ["2000", "cost"],
      ["2002", "cost"],
      ["2002", "depreciation"],
      ["2000", "excluded"],
    ]);
  });

  it("认不出编码的科目按科目串本身分组，互不混并", () => {
    const views = groupAssignmentViews([
      {
        entity: "A",
        account: "Accumulated Depreciation",
        role: "depreciation",
        category: "固定资产",
      },
      {
        entity: "A",
        account: "Accumulated Depreciation - Vehicles",
        role: "depreciation",
        category: "固定资产",
      },
    ]);
    expect(views).toHaveLength(2);
    expect(views.map((view) => view.key)).toEqual([
      "Accumulated Depreciation",
      "Accumulated Depreciation - Vehicles",
    ]);
    // 无来源信息（回退口径）时不显示来源标签。
    expect(views[0].sources).toEqual([]);
  });

  it("两侧 entityAccounts 均为空时得到空清单（页面据此回退笛卡尔积）", () => {
    expect(unionEntityAccounts([], [])).toEqual([]);
    expect(unionEntityAccounts(undefined, undefined)).toEqual([]);
  });
});

describe("FA TB+JE 三步向导（源码契约）", () => {
  const source = readFileSync(
    new URL("./FaTbJePage.tsx", import.meta.url),
    "utf8",
  );
  const stepOne = source.slice(
    source.indexOf("{step === 1 && ("),
    source.indexOf("{step === 2 && ("),
  );

  it("步骤条只有三步：上传与映射、科目复核、预览与导出", () => {
    const stepsArray = source.slice(
      source.indexOf("steps={["),
      source.indexOf("]}", source.indexOf("steps={[")),
    );
    expect(stepsArray.match(/key: "/g)).toHaveLength(3);
    expect(stepsArray).toContain('label: "上传与映射"');
    expect(stepsArray).toContain('label: "科目复核"');
    expect(stepsArray).toContain('label: "预览与导出"');
    expect(source).not.toContain('label: "上传与识别"');
    expect(source).not.toContain('label: "字段映射"');
  });

  it("第 1 步同屏承载源卡片、LLM 联合复核与两侧字段映射面板", () => {
    expect(stepOne).toContain("FaLedgerSourceCard");
    expect(stepOne).toContain("<LedgerReviewAll");
    expect(stepOne).toContain("<FaTbJeMappingPanel");
    expect(stepOne).not.toContain("继续核对字段");
    expect(source).not.toContain("返回上传\n");
  });

  it("第 1 步底部门禁为「TB/JE 均已识别且必填字段映射完成」，按钮为复核科目分类", () => {
    expect(stepOne).toContain("复核科目分类");
    expect(stepOne).toContain("disabled={!mappingsReady || reviewing || busy}");
    expect(stepOne).toContain("openAccountReview");
  });

  it("payload 仍逐条使用 assignments 原始科目串，显示合并只发生在复核表", () => {
    expect(source).toContain("accountAssignments: assignments");
    expect(source).toMatch(/groupAssignmentViews\(\s*assignments/);
  });

  it("复核表只列 TB 科目，并提供按编码或名称即时筛选", () => {
    expect(source).toContain('<div className="fa-tbje-account-cell">');
    expect(source).not.toContain(
      '<td\n                        className="fa-tbje-account-cell"',
    );
    expect(source).toContain(
      "faReviewEntityAccounts(inspects.tb?.entityAccounts, entityKeyEnabled)",
    );
    expect(source).toContain('ariaLabel="筛选科目"');
    expect(source).toContain('placeholder="输入科目编码或名称"');
    expect(source).not.toContain('className="fa-tbje-source-tag"');
    expect(source).not.toContain("批量资产类别");
  });

  it("切换 FA 子工具时缓存并恢复 TB+JE 草稿", () => {
    expect(source).toContain("let faTbJeDraftCache");
    expect(source).toContain("faTbJeDraftCache = {");
    expect(source).toContain("faTbJeDraftCache?.mappings");
    expect(source).toContain("faTbJeDraftCache?.assignments");
  });
});
