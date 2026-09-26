import { DataTable } from "../components/DataTable";
import { useTableColumnResize } from "../components/useTableColumnResize";

/**
 * 开发环境专用：列宽调整能力的浏览器验收夹具（?col-resize-fixture）。
 *
 * 覆盖三种典型形态：
 * 1. 公共 DataTable + 长文本截断列（拖宽 / 双击自适应的受益场景）；
 * 2. 外部已有 colgroup 的表（账表核对结果表的形态，验证复用不破坏）；
 * 3. 粘性表头 + 横向滚动容器（验证拖动与滚动的交互）。
 */

const previewColumns = ["科目编码", "科目名称", "辅助核算", "期初余额", "借方发生", "贷方发生", "期末余额"];

const previewRows = [
  ["1002.01", "银行存款—招商银行基本户（人民币）", "招商银行营业部", "17,123,956.87", "8,204,113.02", "6,518,904.44", "18,809,165.45"],
  ["1123", "预付账款—设备采购预付款（跨年度摊销）", "华东供应商集群", "1,778,840.00", "955,032.15", "2,178,452.31", "555,419.84"],
  ["1601.03", "固定资产—工具仪器（五年折旧）", "生产设备科", "5,845,831.20", "833,497.73", "1,531,715.56", "5,147,613.37"],
  ["6602.17", "管理费用—折旧费（本月计提）", "总部管理", "0.00", "1,914,709.40", "0.00", "1,914,709.40"],
];

function ForeignColgroupTable() {
  const resize = useTableColumnResize<HTMLDivElement>({ storageKey: "fixture.colgroup" });
  return (
    <div ref={resize.ref} style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table className="demo-colgroup-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <colgroup>
          <col style={{ width: "16%" }} />
          <col style={{ width: "28%" }} />
          <col style={{ width: "28%" }} />
          <col style={{ width: "28%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>组</th>
            <th>滚动核实</th>
            <th>账表核对</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>货币资金</td>
            <td>通过：期初+发生-期末勾稽一致</td>
            <td>通过：TB 与 JE 双方金额一致</td>
            <td>查看明细</td>
          </tr>
          <tr>
            <td>预付账款</td>
            <td>差异 0.84：存在未勾稽的辅助明细行</td>
            <td>通过</td>
            <td>查看明细</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function StickyHeaderTable() {
  const resize = useTableColumnResize<HTMLDivElement>({ storageKey: "fixture.sticky" });
  return (
    <div ref={resize.ref} style={{ maxHeight: 220, overflow: "auto" }}>
      <table className="demo-sticky-table" style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["凭证日期", "凭证号", "摘要", "金额", "对方科目"].map((label) => (
              <th key={label} style={{ position: "sticky", top: 0 }}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 14 }, (_, row) => (
            <tr key={row}>
              <td>2026-0{Math.floor(row / 10) + 1}-{String((row % 28) + 1).padStart(2, "0")}</td>
              <td>记-{String(row + 1).padStart(4, "0")}</td>
              <td>支付华东供应商集群设备采购尾款（合同编号 HZ-2026-{String(row + 1).padStart(3, "0")}）</td>
              <td>{((row + 1) * 12500.5).toFixed(2)}</td>
              <td>2202 应付账款—设备采购</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ColResizeFixture() {
  return (
    <main style={{ padding: 24, display: "grid", gap: 32, minWidth: 0 }}>
      <h1>列宽调整验收夹具</h1>
      <section>
        <h2>公共 DataTable（映射预览形态）</h2>
        <DataTable
          resizeKey="fixture.data-table"
          columns={previewColumns}
          rows={previewRows}
          maxHeight={200}
        />
      </section>
      <section>
        <h2>外部 colgroup 表（账表核对形态）</h2>
        <ForeignColgroupTable />
      </section>
      <section>
        <h2>粘性表头滚动表</h2>
        <StickyHeaderTable />
      </section>
    </main>
  );
}
