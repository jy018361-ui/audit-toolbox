# fuzzy-match 词表资源来源说明

「两列模糊匹配」工具的中文词表资源，全部下载/整理于 **2026-08-25**。
下载方式：GitHub raw（`raw.githubusercontent.com`）。生成脚本为一次性整理脚本（未入库），
本文件记录每个最终文件的来源、协议与处理方式，保证可追溯、可复现。

## 文件清单

| 文件 | 用途 | 大小 |
|---|---|---|
| `company_suffix.json` | 公司后缀剥离词表 + 归一映射 | ~4.2 KB |
| `china_regions.json` | 省/市/区县三级行政区划词典（含别称） | ~105 KB |
| `TSCharacters.txt` | 繁→简 单字词典（OpenCC 原版 TSV） | ~102 KB |
| `TSPhrases.txt` | 繁→简 词组词典（OpenCC 原版 TSV） | ~8.8 KB |

## company_suffix.json

- **strip_words**（179 条，按词长降序，等长按字典序，尾部剥离时长词优先）：
  - 主体来源：[shibing624/companynameparser](https://github.com/shibing624/companynameparser)
    （协议 **Apache-2.0**）的 `companynameparser/data/suffix.txt`（162 词，全量保留）。
  - 整理补充（原表没有的组织形式，共 17 条）：`集团有限公司`、`控股集团有限公司`、
    `合伙企业`、`普通合伙`、`特殊普通合伙`、`普通合伙企业`、`特殊普通合伙企业`、
    `有限合伙企业`、`事务所`、`研究院`、`研究所`、`大学`、`学校`、`个体工商户`、
    `分厂`、`支行`、`代表处`、`办事处`。
- **normalize_map**（43 条，字面量映射）：
  - 中文后缀 + 全角括号归一（9 条）与英文缩写归一（31 条，原为 `re` 正则、已字面化为
    小写键，使用前应先把名称小写化）来源：
    [lsgggggg/NameLink](https://github.com/lsgggggg/NameLink)（协议 **MIT**）的
    `company_matcher.py` 常量 `SUFFIX_NORMALIZE`。
  - 整理补充 3 条：`股份公司`→`有限公司`、`集团有限公司`→`有限公司`、`控股有限公司`→`有限公司`。

## china_regions.json

- 来源：[DQinYuan/chinese_province_city_area_mapper](https://github.com/DQinYuan/chinese_province_city_area_mapper)
  （协议 **MIT**）的 `cpca/resources/adcodes.csv`（3511 行：34 省级 / 344 市级 / 3133 区县级，
  原始文件含 adcode 与经纬度，本项目仅用 adcode 前缀推导层级 + 名称，**不含编码与坐标**）。
- 结构：`provinces[] -> cities[] -> areas[]` 三级；省级另带 `areas` 字段存放**省直辖县级**名单
  （直辖市辖区、重庆辖县、冀豫鄂琼的省直辖县级行政区划——原始数据中 9 个占位市名
  `市辖区`/`县`/`省直辖县级行政区划` 已归并上提，故市级条目为 335 个）。
- 别称（`aliases`）为整理时生成，规则：
  - 省：去掉 `省/市/特别行政区/自治区` 后缀（内蒙古自治区→内蒙古，另加内蒙；上海市→上海）；
  - 市：去掉 `市/盟/地区` 后缀；自治州再去掉尾部民族名（恩施土家族苗族自治州→恩施）；
  - 市级别称若与任何省名或省别称冲突则剔除（青海海南藏族自治州不产生“海南”别称）；
  - 区县级不加别称（避免朝阳区/朝阳市这类误匹配），同名区县保留在各自市下。

## OpenCC 繁简词典（两个 .txt）

- 来源：[BYVoid/OpenCC](https://github.com/BYVoid/OpenCC)（协议 **Apache-2.0**）的
  `data/dictionary/` 目录，**原样放入，未改格式**（TSV：`原文<TAB>转换结果[ 空格分隔多个候选]`，
  前三行为 `#` 注释头，解析时需跳过）。
- 方向说明（注意）：OpenCC 的 `ST` 前缀是 **简→繁**（Simplified→Traditional），
  `TS` 前缀才是 **繁→简**。需求（公司名归一化）是繁→简，**实现时优先内嵌 `TSCharacters.txt`
  + `TSPhrases.txt`（合计约 110 KB）**；`ST` 两个文件一并保留仅作方向参考/反向用途，
  如需控制 EXE 体积可不内嵌。
- OpenCC 的繁→简以单字表为主（TSCharacters 4148 条数据行），
  词组表（TSPhrases 477 条数据行）只做多音/异体修正，这是其官方设计。

## 协议汇总

| 仓库 | 协议 |
|---|---|
| shibing624/companynameparser | Apache-2.0 |
| lsgggggg/NameLink | MIT |
| DQinYuan/chinese_province_city_area_mapper | MIT |
| BYVoid/OpenCC | Apache-2.0 |

均允许随闭源/ proprietary 桌面应用分发词表数据；Apache-2.0 的两个需保留上述署名说明（本文件即此用途）。
