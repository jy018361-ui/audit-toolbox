//! 贷款市场报价利率（LPR）内置报价表。
//!
//! 浮动利率借款的定价基准绝大多数挂 LPR。台账往往只写「LPR+90BP」而不列基准值，
//! 逐笔去查报价既繁琐又容易抄错，所以内置一份。
//!
//! # 这份数据怎么用才安全
//!
//! **它是默认值，不是权威。** 导出的底稿里有一张「LPR报价表」Sheet 列出全表，
//! 主表的基准利率、有效年利率、测算利息三列都是**指向那张 Sheet 的公式**——
//! 发现某一期报价不对或者需要补录新报价，在 Sheet 里改一个格子，整份底稿重算。
//! 这是刻意的：内置表迟早会过期，过期时用户必须能自己修，而不是拿到一份
//! 看不出哪里错了的死数。
//!
//! # 表的形态：只存调整点
//!
//! LPR 每月 20 日报价，但绝大多数月份与上月持平。这里**只存利率发生变化的那些日期**，
//! 查询按「不晚于基准日的最近一次调整」取值——利率结果与逐月存完全一致。
//! 因此表里的日期列含义是**利率调整生效日**，不是「那一天恰好有报价」，
//! Sheet 的表头也按这个含义写。
//!
//! # 数据边界
//!
//! [`QUOTES_THROUGH`] 是本表的数据截止日。基准日晚于它的借款仍会用最后一期报价算出
//! 数字（用户要的是一份完整草稿），但会被标为待复核并写明原因——**不静默当成准确值**。

use chrono::NaiveDate;

/// 一次 LPR 调整。利率单位是**百分数**（`3.85` 表示 3.85%），与公开报价的写法一致；
/// 底稿 Sheet 里也按百分数列示，除以 100 的动作放在公式里，用户看得见。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Quote {
    pub(crate) year: i32,
    pub(crate) month: u32,
    pub(crate) day: u32,
    /// 1 年期 LPR（%）。
    pub(crate) one_year: f64,
    /// 5 年期以上 LPR（%）。
    pub(crate) over_five_year: f64,
}

/// 本表的数据截止日：这一天之后的报价**未收录**。
///
/// 基准日晚于此的借款按最后一期报价测算，同时标待复核，提示在底稿的
/// 「LPR报价表」Sheet 里补录后重算。维护本表时这个日期要跟着改。
pub(crate) const QUOTES_THROUGH: (i32, u32, u32) = (2026, 8, 20);

pub(crate) const HISTORY_SOURCE: &str =
    "https://www.boc.cn/fimarkets/lilv/fd32/201310/t20131031_2591219.html";
pub(crate) const LATEST_SOURCE: &str =
    "https://www.chinamoney.com.cn/chinese/rdgz/20260820/3399885.html";

/// LPR 调整点，**按日期升序**（查询依赖这个顺序，新增时务必插在正确位置）。
///
/// 2019 年 8 月 LPR 改革后的全部调整点。数据来源是全国银行间同业拆借中心的公开报价，
/// 2026-08-28 已逐项核对中国银行官网转载的全国银行间同业拆借中心历史月度报价
/// （HISTORY_SOURCE），并核验中国货币网 2026-08-20 原公告（LATEST_SOURCE）。
/// 2025-05-20 之后截至核验截止日的月度报价均未调整；截止日不等于最后调整日。
static QUOTES: &[Quote] = &[
    Quote {
        year: 2019,
        month: 8,
        day: 20,
        one_year: 4.25,
        over_five_year: 4.85,
    },
    Quote {
        year: 2019,
        month: 9,
        day: 20,
        one_year: 4.20,
        over_five_year: 4.85,
    },
    Quote {
        year: 2019,
        month: 11,
        day: 20,
        one_year: 4.15,
        over_five_year: 4.80,
    },
    Quote {
        year: 2020,
        month: 2,
        day: 20,
        one_year: 4.05,
        over_five_year: 4.75,
    },
    Quote {
        year: 2020,
        month: 4,
        day: 20,
        one_year: 3.85,
        over_five_year: 4.65,
    },
    Quote {
        year: 2021,
        month: 12,
        day: 20,
        one_year: 3.80,
        over_five_year: 4.65,
    },
    Quote {
        year: 2022,
        month: 1,
        day: 20,
        one_year: 3.70,
        over_five_year: 4.60,
    },
    Quote {
        year: 2022,
        month: 5,
        day: 20,
        one_year: 3.70,
        over_five_year: 4.45,
    },
    Quote {
        year: 2022,
        month: 8,
        day: 22,
        one_year: 3.65,
        over_five_year: 4.30,
    },
    Quote {
        year: 2023,
        month: 6,
        day: 20,
        one_year: 3.55,
        over_five_year: 4.20,
    },
    Quote {
        year: 2023,
        month: 8,
        day: 21,
        one_year: 3.45,
        over_five_year: 4.20,
    },
    Quote {
        year: 2024,
        month: 2,
        day: 20,
        one_year: 3.45,
        over_five_year: 3.95,
    },
    Quote {
        year: 2024,
        month: 7,
        day: 22,
        one_year: 3.35,
        over_five_year: 3.85,
    },
    Quote {
        year: 2024,
        month: 10,
        day: 21,
        one_year: 3.10,
        over_five_year: 3.60,
    },
    Quote {
        year: 2025,
        month: 5,
        day: 20,
        one_year: 3.00,
        over_five_year: 3.50,
    },
];

pub(crate) fn quotes() -> &'static [Quote] {
    QUOTES
}

impl Quote {
    pub(crate) fn date(&self) -> NaiveDate {
        NaiveDate::from_ymd_opt(self.year, self.month, self.day).expect("内置报价表日期合法")
    }
    /// 按期限取该期报价（%）。
    pub(crate) fn rate(&self, term: Term) -> f64 {
        match term {
            Term::OneYear => self.one_year,
            Term::OverFiveYear => self.over_five_year,
        }
    }
}

/// LPR 的两个期限品种。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Term {
    OneYear,
    OverFiveYear,
}

impl Term {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Term::OneYear => "1年期",
            Term::OverFiveYear => "5年期以上",
        }
    }
    /// 缺少合同定价品种时的估算：期限超过 5 年暂用「5 年期以上」，否则暂用「1 年期」。
    ///
    /// 央行口径允许 1 至 5 年贷款由金融机构自主选择参考期限品种，因此这不是
    /// 确定性合同结论；调用方必须保留待复核标记。整 60 个月暂归 1 年期。
    /// 比较按月加减而不是数天数：闰年会让「5 年」时长在 1825/1826 天之间摆动，
    /// 数天数会让同样是 60 个月的两笔借款落到不同品种上。
    /// 起止日不全时按 1 年期（多数流贷都在一年以内）。
    pub(crate) fn of_loan(start: Option<NaiveDate>, end: Option<NaiveDate>) -> Term {
        match (start, end) {
            (Some(s), Some(e)) => {
                let five_years = s.checked_add_months(chrono::Months::new(60));
                match five_years {
                    Some(limit) if e > limit => Term::OverFiveYear,
                    _ => Term::OneYear,
                }
            }
            _ => Term::OneYear,
        }
    }
}

/// 数据截止日。
pub(crate) fn through() -> NaiveDate {
    let (y, m, d) = QUOTES_THROUGH;
    NaiveDate::from_ymd_opt(y, m, d).expect("数据截止日合法")
}

/// 一次查询的结果。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Lookup {
    /// 年利率**小数**（0.0385），可直接参与计息。
    pub(crate) rate: f64,
    /// 采用的那次调整的生效日。
    pub(crate) effective: NaiveDate,
    /// 采用的期限品种。
    pub(crate) term: Term,
    /// 基准日晚于 [`through`]：本表未必收录了当时的最新报价，结论要复核。
    pub(crate) stale: bool,
}

/// 取基准日适用的 LPR：**不晚于基准日的最近一次调整**。
///
/// 基准日早于 2019 年 8 月首次报价（LPR 改革之前）时返回 `None`——那个年代挂的是
/// 央行基准贷款利率，不是 LPR，硬套会得出一个看似合理的错数。
pub(crate) fn lookup(basis: NaiveDate, term: Term) -> Option<Lookup> {
    let hit = QUOTES.iter().rev().find(|q| q.date() <= basis)?;
    Some(Lookup {
        rate: hit.rate(term) / 100.0,
        effective: hit.date(),
        term,
        stale: basis > through(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn 报价表按日期升序且日期合法() {
        let mut last: Option<NaiveDate> = None;
        for q in quotes() {
            let date = q.date();
            assert!(
                last.is_none_or(|prev| prev < date),
                "报价表必须严格升序：{date}"
            );
            last = Some(date);
            assert!(q.one_year > 0.0 && q.over_five_year > 0.0);
            // 5 年期以上从来没有低于过 1 年期。录错了这条会先炸。
            assert!(
                q.over_five_year >= q.one_year,
                "{date} 的 5 年期以上低于 1 年期"
            );
        }
        assert!(
            last.is_some_and(|date| date <= through()),
            "最后调整日不能晚于核验截止日"
        );
    }

    #[test]
    fn 取不晚于基准日的最近一次调整() {
        // 2023-03-15 之前最近的一次调整是 2022-08-22（3.65 / 4.30）。
        let hit = lookup(d(2023, 3, 15), Term::OneYear).unwrap();
        assert!((hit.rate - 0.0365).abs() < 1e-12);
        assert_eq!(hit.effective, d(2022, 8, 22));
        assert!(!hit.stale);
        // 同一天的 5 年期以上是 4.30。
        assert!((lookup(d(2023, 3, 15), Term::OverFiveYear).unwrap().rate - 0.0430).abs() < 1e-12);
    }

    #[test]
    fn 调整生效当天即适用新报价() {
        assert!((lookup(d(2024, 10, 21), Term::OneYear).unwrap().rate - 0.0310).abs() < 1e-12);
        assert!((lookup(d(2024, 10, 20), Term::OneYear).unwrap().rate - 0.0335).abs() < 1e-12);
    }

    #[test]
    fn 改革之前没有lpr() {
        assert_eq!(lookup(d(2019, 8, 19), Term::OneYear), None);
        assert!(lookup(d(2019, 8, 20), Term::OneYear).is_some());
    }

    #[test]
    fn 超出数据截止日的标为待核() {
        let hit = lookup(d(2026, 8, 21), Term::OneYear).unwrap();
        assert!(hit.stale, "基准日晚于数据截止日必须标 stale");
        // 仍然给得出数字（用户要的是完整草稿），只是要复核。
        assert!((hit.rate - 0.0300).abs() < 1e-12);
        assert!(!lookup(d(2026, 8, 20), Term::OneYear).unwrap().stale);
        assert_eq!(
            lookup(d(2026, 8, 20), Term::OneYear).unwrap().effective,
            d(2025, 5, 20)
        );
    }

    #[test]
    fn 期限超过五年才用五年期以上() {
        // 10 年期的经营性物业贷（05 金陵润庭那种）：5 年期以上。
        assert_eq!(
            Term::of_loan(Some(d(2022, 11, 10)), Some(d(2032, 11, 9))),
            Term::OverFiveYear
        );
        // 整 60 个月不算「5 年期以上」——字面就是超过 5 年才算。
        assert_eq!(
            Term::of_loan(Some(d(2023, 1, 10)), Some(d(2028, 1, 9))),
            Term::OneYear
        );
        // 多一天就跨过去了。
        assert_eq!(
            Term::of_loan(Some(d(2023, 1, 10)), Some(d(2028, 1, 11))),
            Term::OverFiveYear
        );
        // 跨闰年不影响判定：同样是 60 个月，含不含 2 月 29 日结果一致。
        assert_eq!(
            Term::of_loan(Some(d(2019, 3, 1)), Some(d(2024, 3, 1))),
            Term::OneYear
        );
        assert_eq!(
            Term::of_loan(Some(d(2024, 1, 15)), Some(d(2025, 1, 14))),
            Term::OneYear
        );
        // 起止日不全时按 1 年期。
        assert_eq!(Term::of_loan(None, None), Term::OneYear);
    }
}
