import { FaPivotTable } from "../FaTbJePage";

const originalRows = [
  { entity: "默认主体", account: "10020001-招商银行-基本户（0802）", debit: 0, credit: 1712395.87 },
  { entity: "默认主体", account: "11230001-预付账款-人民币", debit: 177840, credit: 4558618.31 },
  { entity: "默认主体", account: "16010003-工具仪器", debit: 584583.12, credit: 153171.56 },
  { entity: "默认主体", account: "16010004-数据处理设备", debit: 833497.73, credit: 3043.71 },
];

const depreciationRows = [
  { entity: "默认主体", account: "16010003-工具仪器", debit: 191150.38, credit: 153171.56 },
  { entity: "默认主体", account: "16010004-数据处理设备", debit: 0, credit: 3043.71 },
  { entity: "默认主体", account: "16020002-机械设备", debit: 507550, credit: 82467.38 },
  { entity: "默认主体", account: "66020017-折旧费", debit: 190470.94, credit: 0 },
];

/** 开发环境专用：把任务结束后的两张实际透视表直接放入尺寸矩阵。 */
export function FaPivotFixture() {
  return (
    <main className="fa-tbje-page" style={{ padding: 24, minWidth: 0 }}>
      <h1>FA 对方科目并排预览</h1>
      <div className="fa-tbje-pivot-grid">
        <FaPivotTable title="原值对方科目" rows={originalRows} />
        <FaPivotTable title="累计折旧对方科目" rows={depreciationRows} />
      </div>
    </main>
  );
}
