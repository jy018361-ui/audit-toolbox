# Case Workpaper Diagnostic

Case folder: `固定资产质检agent/案例库`

## Scope

- Diagnose sheet recognition, header row detection, field synonym mapping, and required field coverage.
- This run skips files larger than 20MB and focuses on six smaller sanitized workpapers.
- This report does not execute QC rules or audit conclusions.
- Header detection scans the first 100 rows and first 100 columns per sheet.

## Recognition Overview

- `K1 SWP 固定资产 20251231 B医疗公司.xlsx`: summary:1, lead:1, rollforward:1, fa_list:1, addition_list:1, disposal_list:1, sap:1, depreciation_tod:1, depreciation_policy:1
- `K1 SWP 固定资产 20251231 C新材料有限公司.xlsx`: summary:2, lead:2, rollforward:2, fa_list:2, addition_list:1, disposal_list:1, sap:1, depreciation_tod:2, depreciation_policy:1
- `K1 SWP 固定资产 20251231 D锂电科技有限公司.xlsx`: summary:2, lead:2, rollforward:2, fa_list:2, addition_list:1, disposal_list:1, sap:0, depreciation_tod:1, depreciation_policy:1
- `K1 SWP 固定资产 20251231 E锂原.xlsx`: summary:1, lead:1, rollforward:1, fa_list:1, addition_list:1, disposal_list:1, sap:0, depreciation_tod:1, depreciation_policy:1
- `K1 SWP 固定资产 20251231 F有限公司.xlsx`: summary:2, lead:3, rollforward:3, fa_list:3, addition_list:1, disposal_list:1, sap:1, depreciation_tod:2, depreciation_policy:1
- `K1 SWP 固定资产 20251231 G科技.xlsx`: summary:1, lead:1, rollforward:1, fa_list:1, addition_list:1, disposal_list:1, sap:0, depreciation_tod:1, depreciation_policy:1

## Files

- Diagnosed: `K1 SWP 固定资产 20251231 B医疗公司.xlsx` (0.8 MB)
- Diagnosed: `K1 SWP 固定资产 20251231 C新材料有限公司.xlsx` (0.6 MB)
- Diagnosed: `K1 SWP 固定资产 20251231 D锂电科技有限公司.xlsx` (0.5 MB)
- Diagnosed: `K1 SWP 固定资产 20251231 E锂原.xlsx` (0.7 MB)
- Diagnosed: `K1 SWP 固定资产 20251231 F有限公司.xlsx` (0.7 MB)
- Diagnosed: `K1 SWP 固定资产 20251231 G科技.xlsx` (1.4 MB)
- Skipped: `K1 SWP 固定资产 20251231 A有限公司.xlsx` (40.9 MB)

## K1 SWP 固定资产 20251231 B医疗公司.xlsx

### Sheet Recognition
- `Comments【归档前删除】` -> `unclassified`
- `汇总 ` -> `summary`
- `K.00 Lead Sheet` -> `lead`
- `K.01 Agree SL to GL` -> `rollforward`
- `K.01.1a FA list` -> `fa_list`
- `K1_400折旧测试` -> `unclassified`
- `K.02.1 新增测试 ` -> `unclassified`
- `新增清单` -> `addition_list`
- `K.02.1a 新增选样输出` -> `unclassified`
- `K.02.2 处置测试` -> `unclassified`
- `处置清单` -> `disposal_list`
- `K.03.1 SAP` -> `sap`
- `K.03.2 折旧测试TOD` -> `depreciation_tod`
- `K.03.3 折旧政策复核` -> `depreciation_policy`
- `DS_INTERNAL_DOCUMENT_STORAGE` -> `unclassified`
- `DS_INTERNAL_SETTINGS_STORAGE` -> `unclassified`
- `DS_INTERNAL_DOCGROUP_STORAGE` -> `unclassified`
- `DS_INTERNAL_SNIP_STORAGE` -> `unclassified`

### Key Sheet Diagnostics
#### `K.01.1a FA list` (`fa_list`)
- Header candidate row: 16
- Mapped field count: 11
- Mapped fields: `asset_category` <- 固定资产类别 (col 3), `asset_id` <- 固定资产编号 (col 4), `asset_name` <- 固定资产名称 (col 5), `start_date` <- 入账开始日期 (col 6), `useful_life_months` <- 使用寿命(月) (col 7), `salvage_rate` <- 残值率 (col 8), `original_value` <- 期初原值 (col 9), `accumulated_depreciation` <- 期初累计折旧 (col 10), `current_depreciation` <- 本期计提折旧 (col 11), `impairment_provision` <- 减值准备 (col 14), `net_value` <- 净值 (col 15)
- Missing required fields: None
- Unmapped header candidates: `已提足折旧`

#### `新增清单` (`addition_list`)
- Header candidate row: 4
- Mapped field count: 10
- Mapped fields: `asset_category` <- 固定资产类别 (col 2), `asset_id` <- 固定资产编号 (col 3), `asset_name` <- 固定资产名称 (col 4), `start_date` <- 入账开始日期 (col 5), `useful_life_months` <- 使用寿命(月) (col 6), `salvage_rate` <- 残值率 (col 7), `original_value` <- 期初原值 (col 8), `accumulated_depreciation` <- 期初累计折旧 (col 9), `current_depreciation` <- 本期计提折旧 (col 10), `addition_method` <- 新增方式 (col 12)
- Missing required fields: None

#### `处置清单` (`disposal_list`)
- Header candidate row: 10
- Mapped field count: 12
- Mapped fields: `asset_category` <- 固定资产类别 (col 2), `asset_id` <- 固定资产编号 (col 3), `asset_name` <- 固定资产名称 (col 4), `start_date` <- 入账开始日期 (col 5), `disposal_date` <- 处置日期 (col 6), `useful_life_months` <- 使用寿命(月) (col 7), `salvage_rate` <- 残值率 (col 8), `original_value` <- 期初原值 (col 9), `accumulated_depreciation` <- 期初累计折旧 (col 10), `current_depreciation` <- 本期计提折旧 (col 11), `impairment_provision` <- 减值准备 (col 14), `net_value` <- 净值 (col 15)
- Missing required fields: `disposal_method`
- Unmapped header candidates: `已提足折旧`

#### `K.03.2 折旧测试TOD` (`depreciation_tod`)
- Header candidate row: 31
- Mapped field count: 6
- Mapped fields: `asset_category` <- 固定资产类别 (col 4), `asset_id` <- 固定资产编号 (col 6), `asset_name` <- 固定资产名称 (col 7), `original_value` <- 原值 (col 8), `useful_life_months` <- 资本开始折旧的日期 （即使用寿命开始时间） (col 10), `current_depreciation` <- 账面计提折旧费用 (col 14)
- Missing required fields: `start_date`, `salvage_rate`, `accumulated_depreciation`, `net_value`
- Unmapped header candidates: `样本数量` | `样本类型` | `总账账户代码` | `可折旧金额 （考虑残值后金额）` | `折旧方法` | `本年应折旧月份` | `差异` | `获得的证据/支持的描述` | `1` | `2`


## K1 SWP 固定资产 20251231 C新材料有限公司.xlsx

### Sheet Recognition
- `汇总-24` -> `summary`
- `K.00 Lead Sheet-24` -> `lead`
- `K.01 Agree SL to GL-24` -> `rollforward`
- `FA list-24` -> `fa_list`
- `汇总 ` -> `summary`
- `K.00 Lead Sheet` -> `lead`
- `K.01 Agree SL to GL` -> `rollforward`
- `FA list` -> `fa_list`
- `K.02.1 新增测试 ` -> `unclassified`
- `新增清单` -> `addition_list`
- `K.02.2 处置测试` -> `unclassified`
- `处置清单` -> `disposal_list`
- `K.03.1 SAP` -> `sap`
- `K.03.2 折旧测试TOD` -> `depreciation_tod`
- `K.03.2 折旧测试TOD-by item测试` -> `depreciation_tod`
- `K.03.3 折旧政策复核` -> `depreciation_policy`

### Key Sheet Diagnostics
#### `FA list-24` (`fa_list`)
- Header candidate row: 9
- Mapped field count: 8
- Mapped fields: `asset_category` <- 资产类别 (col 1), `asset_name` <- 资产名称 (col 6), `start_date` <- 开始使用日期 (col 12), `original_value` <- 资产原值 (col 21), `accumulated_depreciation` <- 累计折旧 (col 22), `net_value` <- 资产净值 (col 23), `impairment_provision` <- 累计减值准备 (col 24), `asset_id` <- 资产编码 (col 42)
- Missing required fields: `useful_life_months`, `salvage_rate`
- Unmapped header candidates: `资产组织` | `货主组织` | `卡片编码` | `25年资产处置清单` | `计量单位(卡片)` | `数量(卡片)` | `处置情况` | `资产状态` | `变动方式` | `卡片来源` | `备注` | `入账日期`

#### `FA list` (`fa_list`)
- Header candidate row: 8
- Mapped field count: 9
- Mapped fields: `asset_category` <- 固定资产类别 (col 1), `asset_id` <- 资产编号 (col 2), `asset_name` <- 资产名称 (col 3), `useful_life_months` <- 使用寿命 (col 5), `salvage_rate` <- 残值率 (col 6), `original_value` <- 资产原值 (col 7), `accumulated_depreciation` <- 累计折旧 (col 8), `net_value` <- 净值 (col 9), `impairment_provision` <- 累计减值准备 (col 12)
- Missing required fields: `start_date`
- Unmapped header candidates: `入账日期` | `未税成本` | `进项税额` | `账面价值` | `预计残值` | `折旧年期` | `最后一期折旧金额` | `未提折旧金额` | `折旧方法` | `预计使用期间数` | `累计使用期间数`

#### `新增清单` (`addition_list`)
- Header candidate row: 7
- Mapped field count: 5
- Mapped fields: `asset_category` <- 固定资产类别 (col 1), `asset_id` <- 资产编号 (col 2), `asset_name` <- 资产名称 (col 3), `original_value` <- 资产原值 (col 5), `addition_method` <- 新增方式 (col 6)
- Missing required fields: `start_date`
- Unmapped header candidates: `入账日期`

#### `处置清单` (`disposal_list`)
- Header candidate row: 9
- Mapped field count: 8
- Mapped fields: `asset_id` <- 单据编号 (col 2), `asset_category` <- 固定资产类别 (col 3), `asset_name` <- 资产名称 (col 5), `original_value` <- 处置原值 (col 6), `net_value` <- 处置净值 (col 7), `accumulated_depreciation` <- 处置累计折旧 (col 8), `impairment_provision` <- 减值 (col 9), `disposal_method` <- 处置方式 (col 10)
- Missing required fields: `disposal_date`
- Unmapped header candidates: `业务日期` | `卡片编码` | `数量` | `处置数量` | `货主组织` | `单据状态` | `单据类型`

#### `K.03.2 折旧测试TOD` (`depreciation_tod`)
- Header candidate row: 31
- Mapped field count: 6
- Mapped fields: `asset_category` <- 固定资产类别 (col 4), `asset_id` <- 固定资产编号 (col 6), `asset_name` <- 固定资产名称 (col 7), `original_value` <- 原值 (col 8), `useful_life_months` <- 资本开始折旧的日期 （即使用寿命开始时间） (col 10), `current_depreciation` <- 账面计提折旧费用 (col 14)
- Missing required fields: `start_date`, `salvage_rate`, `accumulated_depreciation`, `net_value`
- Unmapped header candidates: `样本数量` | `样本类型` | `总账账户代码` | `可折旧金额 （考虑残值后金额）` | `折旧方法` | `本年应折旧月份` | `差异` | `获得的证据/支持的描述` | `1` | `2`

#### `K.03.2 折旧测试TOD-by item测试` (`depreciation_tod`)
- Header candidate row: 7
- Mapped field count: 12
- Mapped fields: `asset_category` <- 固定资产类别 (col 1), `asset_id` <- 固定资产编号 (col 2), `asset_name` <- 固定资产名称 (col 3), `start_date` <- 入账开始日期 (col 4), `useful_life_months` <- 使用寿命(月) (col 5), `salvage_rate` <- 残值率 (col 6), `original_value` <- 原值 (col 7), `accumulated_depreciation` <- 累计折旧 (col 8), `impairment_provision` <- 减值准备 (col 9), `net_value` <- 净值 (col 10), `current_depreciation` <- 本期计提折旧 (col 15), `disposal_date` <- 处置日期 (col 16)
- Missing required fields: None
- Unmapped header candidates: `累计应提折旧月` | `累计应折旧金额` | `标记` | `提足折旧时间` | `本期应折旧月数` | `本期应折旧金额` | `本期差异` | `标记`


## K1 SWP 固定资产 20251231 D锂电科技有限公司.xlsx

### Sheet Recognition
- `汇总-24` -> `summary`
- `K.00 Lead Sheet-24` -> `lead`
- `K.01 Agree SL to GL-24` -> `rollforward`
- `FA list-24` -> `fa_list`
- `汇总 ` -> `summary`
- `K.00 Lead Sheet` -> `lead`
- `K.01 Agree SL to GL` -> `rollforward`
- `FA list` -> `fa_list`
- `K.02.1 新增测试 ` -> `unclassified`
- `新增清单` -> `addition_list`
- `K.02.2 处置测试` -> `unclassified`
- `处置清单` -> `disposal_list`
- `K.03.2 折旧测试TOD-by item测试` -> `depreciation_tod`
- `K.03.3 折旧政策复核` -> `depreciation_policy`

### Key Sheet Diagnostics
#### `FA list-24` (`fa_list`)
- Header candidate row: 9
- Mapped field count: 7
- Mapped fields: `asset_category` <- 资产类别 (col 1), `asset_name` <- 资产名称 (col 4), `start_date` <- 开始使用日期 (col 8), `original_value` <- 资产原值 (col 18), `accumulated_depreciation` <- 累计折旧 (col 19), `net_value` <- 资产净值 (col 20), `impairment_provision` <- 累计减值准备 (col 21)
- Missing required fields: `asset_id`, `useful_life_months`, `salvage_rate`
- Unmapped header candidates: `资产组织` | `卡片编码` | `计量单位` | `数量` | `资产状态` | `卡片来源` | `备注` | `会计政策` | `币别` | `入账日期` | `未税成本` | `进项税额`

#### `FA list` (`fa_list`)
- Header candidate row: 9
- Mapped field count: 7
- Mapped fields: `asset_category` <- 资产类别 (col 1), `asset_name` <- 资产名称 (col 4), `start_date` <- 开始使用日期 (col 8), `original_value` <- 资产原值 (col 18), `accumulated_depreciation` <- 累计折旧 (col 19), `net_value` <- 资产净值 (col 20), `impairment_provision` <- 累计减值准备 (col 21)
- Missing required fields: `asset_id`, `useful_life_months`, `salvage_rate`
- Unmapped header candidates: `资产组织` | `卡片编码` | `计量单位` | `数量` | `资产状态` | `卡片来源` | `备注` | `会计政策` | `币别` | `入账日期` | `未税成本` | `进项税额`

#### `新增清单` (`addition_list`)
- Header candidate row: 7
- Mapped field count: 8
- Mapped fields: `asset_category` <- 资产类别 (col 1), `asset_name` <- 资产名称 (col 3), `start_date` <- 开始使用日期 (col 4), `original_value` <- 资产原值 (col 5), `accumulated_depreciation` <- 累计折旧 (col 6), `net_value` <- 资产净值 (col 7), `salvage_rate` <- 残值率 (col 9), `addition_method` <- 新增方式 (col 10)
- Missing required fields: `asset_id`
- Unmapped header candidates: `卡片编码` | `预计残值` | `备注`

#### `处置清单` (`disposal_list`)
- Header candidate row: 8
- Mapped field count: 5
- Mapped fields: `asset_category` <- 资产类别 (col 2), `asset_name` <- 资产名称 (col 4), `original_value` <- 处置原值 (col 5), `accumulated_depreciation` <- 处置累计折旧 (col 6), `disposal_method` <- 处置方式 (col 8)
- Missing required fields: `asset_id`, `net_value`, `disposal_date`
- Unmapped header candidates: `业务日期` | `卡片编码`

#### `K.03.2 折旧测试TOD-by item测试` (`depreciation_tod`)
- Header candidate row: 7
- Mapped field count: 12
- Mapped fields: `asset_category` <- 固定资产类别 (col 1), `asset_id` <- 固定资产编号 (col 2), `asset_name` <- 固定资产名称 (col 3), `start_date` <- 入账开始日期 (col 4), `useful_life_months` <- 使用寿命(月) (col 5), `salvage_rate` <- 残值率 (col 6), `original_value` <- 原值 (col 7), `accumulated_depreciation` <- 累计折旧 (col 8), `impairment_provision` <- 减值准备 (col 9), `net_value` <- 净值 (col 10), `current_depreciation` <- 本期计提折旧 (col 11), `disposal_date` <- 处置日期 (col 12)
- Missing required fields: None
- Unmapped header candidates: `提足折旧时间` | `本期应折旧月数` | `本期应折旧金额` | `本期差异` | `标记` | `累计计提月份` | `累计应折旧金额` | `累计差异`


## K1 SWP 固定资产 20251231 E锂原.xlsx

### Sheet Recognition
- `汇总 ` -> `summary`
- `K.00 Lead Sheet` -> `lead`
- `K.01 Agree SL to GL` -> `rollforward`
- `FA list` -> `fa_list`
- `K.02.1 新增测试 ` -> `unclassified`
- `K.02.1a  抽样输出结果` -> `unclassified`
- `新增清单` -> `addition_list`
- `处置清单` -> `disposal_list`
- `K.03.2 折旧测试TOD-by item测试` -> `depreciation_tod`
- `K.03.3 折旧政策复核` -> `depreciation_policy`

### Key Sheet Diagnostics
#### `FA list` (`fa_list`)
- Header candidate row: 2
- Mapped field count: 8
- Mapped fields: `asset_id` <- 资产编号 (col 3), `asset_name` <- 资产名称 (col 5), `start_date` <- 资本化日期 (col 16), `addition_method` <- 增加方式 (col 19), `original_value` <- 2025年末原值 (col 30), `accumulated_depreciation` <- 2025年末累计折旧 (col 31), `impairment_provision` <- 2025年末固定资产减值 (col 32), `net_value` <- 2025年末净值 (col 33)
- Missing required fields: `asset_category`, `useful_life_months`, `salvage_rate`
- Unmapped header candidates: `公司全称` | `公司代码` | `报表披露分类` | `资产分类长描述` | `规格型号（资产主号文本）` | `附加资产描述` | `旧系统唯一` | `旧系统编码（序列号）` | `旧系统分类` | `计量单位` | `成本中心` | `成本中心描述`

#### `新增清单` (`addition_list`)
- Header candidate row: 7
- Mapped field count: 8
- Mapped fields: `asset_id` <- 资产编号 (col 2), `start_date` <- 资本化日期 (col 4), `addition_method` <- 新增方式 (col 8), `original_value` <- 原值 (col 10), `accumulated_depreciation` <- 累计折旧 (col 11), `net_value` <- 净值 (col 13), `salvage_rate` <- 残值率(%) (col 15), `asset_name` <- 资产名称 (col 16)
- Missing required fields: `asset_category`
- Unmapped header candidates: `计划使用年限` | `首次购置日期` | `资产分类长描述` | `是否新增` | `新增价值` | `本年应计提折旧` | `残值`

#### `处置清单` (`disposal_list`)
- Header candidate row: 8
- Mapped field count: 9
- Mapped fields: `asset_category` <- 固定资产类别 (col 3), `asset_id` <- 编号 (col 4), `asset_name` <- 名称 (col 5), `original_value` <- 原值 (col 6), `accumulated_depreciation` <- 累计折旧 (col 7), `impairment_provision` <- 减值 (col 8), `net_value` <- 净值 (col 9), `disposal_date` <- 处置日期 (col 10), `disposal_method` <- 减少方式 (col 11)
- Missing required fields: None
- Unmapped header candidates: `序号`

#### `K.03.2 折旧测试TOD-by item测试` (`depreciation_tod`)
- Header candidate row: 7
- Mapped field count: 12
- Mapped fields: `asset_category` <- 固定资产类别 (col 2), `asset_id` <- 固定资产编号 (col 3), `asset_name` <- 固定资产名称 (col 4), `start_date` <- 入账开始日期 (col 5), `useful_life_months` <- 使用寿命(月) (col 6), `salvage_rate` <- 残值率 (col 7), `original_value` <- 原值 (col 8), `accumulated_depreciation` <- 累计折旧 (col 9), `impairment_provision` <- 减值准备 (col 10), `net_value` <- 净值 (col 11), `current_depreciation` <- 本期计提折旧 (col 16), `disposal_date` <- 处置日期 (col 17)
- Missing required fields: None
- Unmapped header candidates: `累计应提折旧月` | `累计应折旧金额` | `标记` | `提足折旧时间` | `本期应折旧月数` | `本期应折旧金额` | `本期差异` | `标记`


## K1 SWP 固定资产 20251231 F有限公司.xlsx

### Sheet Recognition
- `K.00 Lead Sheet` -> `lead`
- `K.01 Agree SL to GL` -> `rollforward`
- `汇总-24` -> `summary`
- `K.00 Lead Sheet-24` -> `lead`
- `K.01 Agree SL to GL-24` -> `rollforward`
- `FA list-24` -> `fa_list`
- `汇总 ` -> `summary`
- `K.00 Lead Sheet ` -> `lead`
- `K.01 Agree SL to GL-` -> `rollforward`
- `FA list-` -> `fa_list`
- `FA list` -> `fa_list`
- `K.02.1 新增测试 ` -> `unclassified`
- `新增清单` -> `addition_list`
- `K.02.2 处置测试` -> `unclassified`
- `K.02.2a 处置选样输出` -> `unclassified`
- `处置清单` -> `disposal_list`
- `K.03.1 SAP` -> `sap`
- `K.03.2 折旧测试TOD-by item测试` -> `depreciation_tod`
- `K.03.2 折旧测试TOD` -> `depreciation_tod`
- `K.03.3 折旧政策复核` -> `depreciation_policy`

### Key Sheet Diagnostics
#### `FA list-24` (`fa_list`)
- Header candidate row: 9
- Mapped field count: 9
- Mapped fields: `asset_id` <- 卡片编号 (col 1), `asset_category` <- 企业类别名称 (col 3), `asset_name` <- 固定资产名称 (col 4), `start_date` <- 开始使用日期 (col 5), `original_value` <- 期初原值 (col 9), `accumulated_depreciation` <- 期初累计折旧 (col 13), `net_value` <- 净值 (col 17), `addition_method` <- 增加方式 (col 19), `disposal_method` <- 增加/减少方式 (col 20)
- Missing required fields: `useful_life_months`, `salvage_rate`
- Unmapped header candidates: `入账日期` | `使用年限(月)` | `使用年限(年)` | `本期增加` | `本期减少` | `本期累计计提折旧` | `本期减少` | `存放地点`

#### `FA list-` (`fa_list`)
- Header candidate row: 8
- Mapped field count: 7
- Mapped fields: `asset_category` <- 资产类别 (col 1), `asset_name` <- 资产名称 (col 5), `start_date` <- 开始使用日期 (col 9), `original_value` <- 资产原值 (col 19), `accumulated_depreciation` <- 累计折旧 (col 20), `net_value` <- 资产净值 (col 21), `impairment_provision` <- 累计减值准备 (col 22)
- Missing required fields: `asset_id`, `useful_life_months`, `salvage_rate`
- Unmapped header candidates: `使用部门` | `资产组织` | `卡片编码` | `计量单位` | `数量` | `资产状态` | `卡片来源` | `备注` | `会计政策` | `币别` | `入账日期` | `未税成本`

#### `FA list` (`fa_list`)
- Header candidate row: 8
- Mapped field count: 6
- Mapped fields: `asset_category` <- 资产类别 (col 1), `asset_name` <- 资产名称 (col 3), `start_date` <- 开始使用日期 (col 4), `original_value` <- 资产原值 (col 5), `accumulated_depreciation` <- 累计折旧 (col 6), `net_value` <- 资产净值 (col 7)
- Missing required fields: `asset_id`, `useful_life_months`, `salvage_rate`
- Unmapped header candidates: `卡片编码` | `预计残值` | `折旧方法` | `预计使用期间数` | `变动方式`

#### `新增清单` (`addition_list`)
- Header candidate row: 7
- Mapped field count: 6
- Mapped fields: `asset_category` <- 资产类别 (col 1), `asset_name` <- 资产名称 (col 3), `start_date` <- 开始使用日期 (col 4), `original_value` <- 资产原值 (col 5), `accumulated_depreciation` <- 累计折旧 (col 6), `net_value` <- 资产净值 (col 7)
- Missing required fields: `asset_id`, `addition_method`
- Unmapped header candidates: `卡片编码` | `预计残值` | `折旧方法` | `预计使用期间数` | `变动方式`

#### `处置清单` (`disposal_list`)
- Header candidate row: 2
- Mapped field count: 1
- Mapped fields: `asset_category` <- 获取本期按资产类别划分的固定资产处置清单，包括记录的处置损益，并将该清单与固定资产后推核对一致。调查超过SAD名义金额的差额。 (col 2)
- Missing required fields: `asset_id`, `asset_name`, `original_value`, `accumulated_depreciation`, `net_value`, `disposal_date`, `disposal_method`
- Unmapped header candidates: `返回汇总页`

#### `K.03.2 折旧测试TOD-by item测试` (`depreciation_tod`)
- Header candidate row: 7
- Mapped field count: 12
- Mapped fields: `asset_category` <- 固定资产类别 (col 1), `asset_id` <- 固定资产编号 (col 2), `asset_name` <- 固定资产名称 (col 3), `start_date` <- 入账开始日期 (col 4), `useful_life_months` <- 使用寿命(月) (col 5), `salvage_rate` <- 残值率 (col 6), `original_value` <- 原值 (col 7), `accumulated_depreciation` <- 累计折旧 (col 8), `impairment_provision` <- 减值准备 (col 9), `net_value` <- 净值 (col 10), `current_depreciation` <- 本期计提折旧 (col 11), `disposal_date` <- 处置日期 (col 12)
- Missing required fields: None
- Unmapped header candidates: `提足折旧时间` | `本期应折旧月数` | `本期应折旧金额` | `本期差异` | `标记` | `截止期末应计提月份数` | `差异`

#### `K.03.2 折旧测试TOD` (`depreciation_tod`)
- Header candidate row: 31
- Mapped field count: 6
- Mapped fields: `asset_category` <- 固定资产类别 (col 4), `asset_id` <- 固定资产编号 (col 6), `asset_name` <- 固定资产名称 (col 7), `original_value` <- 原值 (col 8), `useful_life_months` <- 资本开始折旧的日期 （即使用寿命开始时间） (col 10), `current_depreciation` <- 账面计提折旧费用 (col 14)
- Missing required fields: `start_date`, `salvage_rate`, `accumulated_depreciation`, `net_value`
- Unmapped header candidates: `样本数量` | `样本类型` | `总账账户代码` | `可折旧金额 （考虑残值后金额）` | `折旧方法` | `本年应折旧月份` | `差异` | `获得的证据/支持的描述` | `1` | `2`


## K1 SWP 固定资产 20251231 G科技.xlsx

### Sheet Recognition
- `汇总 ` -> `summary`
- `K.00 Lead Sheet` -> `lead`
- `K.01 Agree SL to GL` -> `rollforward`
- `K.01.1a FA list` -> `fa_list`
- `K.02.1b 新增清单` -> `addition_list`
- `K.02.1 新增测试 ` -> `unclassified`
- `K.02.1a新增选样输出` -> `unclassified`
- `处置清单` -> `disposal_list`
- `K.03.3 折旧政策复核` -> `depreciation_policy`
- `K.03.2 折旧测试TOD-by item测试` -> `depreciation_tod`
- `DS_INTERNAL_DOCUMENT_STORAGE` -> `unclassified`
- `DS_INTERNAL_SETTINGS_STORAGE` -> `unclassified`
- `DS_INTERNAL_DOCGROUP_STORAGE` -> `unclassified`
- `DS_INTERNAL_SNIP_STORAGE` -> `unclassified`

### Key Sheet Diagnostics
#### `K.01.1a FA list` (`fa_list`)
- Header candidate row: 17
- Mapped field count: 11
- Mapped fields: `asset_category` <- 固定资产类别 (col 3), `asset_id` <- 固定资产编号 (col 4), `asset_name` <- 固定资产名称 (col 5), `start_date` <- 入账开始日期 (col 6), `useful_life_months` <- 使用寿命(月) (col 7), `salvage_rate` <- 残值率 (col 8), `original_value` <- 期初原值 (col 9), `accumulated_depreciation` <- 期初累计折旧 (col 10), `current_depreciation` <- 本期计提折旧 (col 12), `impairment_provision` <- 减值准备 (col 15), `net_value` <- 净值 (col 16)
- Missing required fields: None
- Unmapped header candidates: `上年是否已提足折旧` | `每月折旧额 EY数`

#### `K.02.1b 新增清单` (`addition_list`)
- Header candidate row: 8
- Mapped field count: 9
- Mapped fields: `asset_category` <- 固定资产类别 (col 3), `asset_id` <- 固定资产编号 (col 4), `asset_name` <- 固定资产名称 (col 5), `start_date` <- 入账开始日期 (col 6), `useful_life_months` <- 使用寿命(月) (col 7), `salvage_rate` <- 残值率 (col 8), `original_value` <- 原值 (col 9), `addition_method` <- 新增方式 (col 10), `current_depreciation` <- 本期计提月份 (col 11)
- Missing required fields: None
- Unmapped header candidates: `权重` | `平均月份`

#### `处置清单` (`disposal_list`)
- Header candidate row: 2
- Mapped field count: 11
- Mapped fields: `asset_category` <- 固定资产类别 (col 1), `asset_id` <- 固定资产编号 (col 2), `asset_name` <- 固定资产名称 (col 3), `original_value` <- 原值 (col 4), `accumulated_depreciation` <- 累计折旧 (col 5), `impairment_provision` <- 减值 (col 6), `net_value` <- 净值 (col 7), `disposal_date` <- 处置日期 (col 8), `disposal_method` <- 处置/报废 (col 9), `useful_life_months` <- 使用寿命 (col 11), `salvage_rate` <- 残值率 (col 12)
- Missing required fields: None

#### `K.03.2 折旧测试TOD-by item测试` (`depreciation_tod`)
- Header candidate row: 17
- Mapped field count: 11
- Mapped fields: `asset_category` <- 固定资产类别 (col 3), `asset_id` <- 固定资产编号 (col 4), `asset_name` <- 固定资产名称 (col 5), `start_date` <- 入账开始日期 (col 6), `useful_life_months` <- 使用寿命(月) (col 7), `salvage_rate` <- 残值率 (col 8), `original_value` <- 期初原值 (col 9), `accumulated_depreciation` <- 期初累计折旧 (col 10), `current_depreciation` <- 本期计提折旧 (col 12), `impairment_provision` <- 减值准备 (col 15), `net_value` <- 净值 (col 16)
- Missing required fields: None
- Unmapped header candidates: `上年是否已提足折旧` | `每月折旧额 EY数`


## Aggregate Findings

### Frequent Missing Required Fields
- `fa_list.salvage_rate`: not recognized in 7 key sheet(s)
- `fa_list.useful_life_months`: not recognized in 7 key sheet(s)
- `fa_list.asset_id`: not recognized in 4 key sheet(s)
- `depreciation_tod.accumulated_depreciation`: not recognized in 3 key sheet(s)
- `depreciation_tod.net_value`: not recognized in 3 key sheet(s)
- `depreciation_tod.salvage_rate`: not recognized in 3 key sheet(s)
- `depreciation_tod.start_date`: not recognized in 3 key sheet(s)
- `disposal_list.disposal_date`: not recognized in 3 key sheet(s)
- `addition_list.asset_id`: not recognized in 2 key sheet(s)
- `disposal_list.asset_id`: not recognized in 2 key sheet(s)
- `disposal_list.disposal_method`: not recognized in 2 key sheet(s)
- `disposal_list.net_value`: not recognized in 2 key sheet(s)
- `addition_list.addition_method`: not recognized in 1 key sheet(s)
- `addition_list.asset_category`: not recognized in 1 key sheet(s)
- `addition_list.start_date`: not recognized in 1 key sheet(s)
- `disposal_list.accumulated_depreciation`: not recognized in 1 key sheet(s)
- `disposal_list.asset_name`: not recognized in 1 key sheet(s)
- `disposal_list.original_value`: not recognized in 1 key sheet(s)
- `fa_list.asset_category`: not recognized in 1 key sheet(s)
- `fa_list.start_date`: not recognized in 1 key sheet(s)

### Frequent Unmapped Header Candidates
- `卡片编码`: 9 occurrence(s)
- `折旧方法`: 7 occurrence(s)
- `入账日期`: 7 occurrence(s)
- `预计残值`: 7 occurrence(s)
- `标记`: 6 occurrence(s)
- `备注`: 5 occurrence(s)
- `未税成本`: 5 occurrence(s)
- `进项税额`: 5 occurrence(s)
- `差异`: 4 occurrence(s)
- `资产组织`: 4 occurrence(s)
- `资产状态`: 4 occurrence(s)
- `卡片来源`: 4 occurrence(s)
- `币别`: 4 occurrence(s)
- `费用金额`: 4 occurrence(s)
- `费用税额`: 4 occurrence(s)
- `账面价值`: 4 occurrence(s)
- `数量`: 4 occurrence(s)
- `提足折旧时间`: 4 occurrence(s)
- `本期应折旧月数`: 4 occurrence(s)
- `本期应折旧金额`: 4 occurrence(s)
- `本期差异`: 4 occurrence(s)
- `计量单位`: 4 occurrence(s)
- `样本数量`: 3 occurrence(s)
- `样本类型`: 3 occurrence(s)
- `总账账户代码`: 3 occurrence(s)
- `可折旧金额 （考虑残值后金额）`: 3 occurrence(s)
- `本年应折旧月份`: 3 occurrence(s)
- `获得的证据/支持的描述`: 3 occurrence(s)
- `1`: 3 occurrence(s)
- `2`: 3 occurrence(s)

## Recommended Next Steps

1. Update `docs/workpaper-fields.md` with newly observed sheet naming patterns, especially `K.01.1a FA list`, `K.02.1b addition list`, and workbook variants with `-24` suffixes.
2. Implement sheet classification before field extraction; many target sheets are present but named with prefixes/suffixes.
3. For recognized `FA list` sheets that still map zero fields, inspect merged or multi-row headers and support multi-row header detection.
4. Keep the 42MB A company workbook out of this first pass; revisit after the lightweight reader is implemented.