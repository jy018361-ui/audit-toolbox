/**
 * TBJE 完整性核对的批量配对。
 *
 * **不读文件内容**。配对只用两样东西：文件名，以及识别阶段顺带拿到的主体清单。
 * 用户一次可能拖进二十个文件，为配对去读几十万行的序时账不值当——宁可配错让
 * 用户改，也不要让他等。
 *
 * 配对键按可靠性排序，逐级退让：
 * 1. **文件名编号 + 期间**：`04TB` ↔ `04JE`、`06科目余额表_2024.1-3` ↔ `06序时账-2024.1-3`。
 *    实测十套样例全部命中。期间必须参与——06 套一年拆成两段导出，1-3 月的余额表
 *    要对 1-3 月的序时账，不能混。
 * 2. **主体代码**：文件名没编号时，用两边识别出的主体清单取交集。
 * 3. 都对不上就落到「未配对」，由用户自己指。
 */

export type LedgerKind = "tb" | "je";

export type PairingFile = {
  /** 文件绝对路径，也是这份文件在配对里的唯一标识。 */
  path: string;
  kind: LedgerKind;
  /** 识别阶段拿到的主体清单，可能为空。 */
  entities?: string[];
};

export type PairedGroup = {
  /** 稳定的组标识，改配对时不变。 */
  id: string;
  /** 给用户看的组名，如「04」「06 · 2024.1-3」。 */
  label: string;
  tb?: PairingFile;
  je?: PairingFile;
  /** 配对依据，逐条列给用户看——这是他判断配得对不对的全部凭据。 */
  reasons: string[];
  /** 需要用户确认：配上了但依据不够硬，或者干脆没配上。 */
  needsReview: boolean;
};

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function stem(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * 文件名开头的编号。`04TB.XLSX` → `04`，`01科目余额表（TB）.xls` → `01`。
 *
 * 只认**开头**的数字：文件名中间的年份、账号（`银行存款3105016`）不是编号。
 */
export function leadingNumber(path: string): string | undefined {
  const matched = /^\s*(\d{1,4})(?!\d)/.exec(stem(path));
  return matched ? matched[1].replace(/^0+(?=\d)/, "") || matched[1] : undefined;
}

/**
 * 文件名里的期间。`06科目余额表_2024.1-3` → `2024.1-3`，
 * `06序时账-2024.4-12` → `2024.4-12`，`09科目余额表-2025` → `2025`。
 *
 * 一年拆成几段导出时，这是把段落对齐的唯一线索——两边都写在文件名里。
 */
export function periodTag(path: string): string | undefined {
  const name = stem(path);
  const ranged = /(\d{4})[.\-年]\s*(\d{1,2})\s*[-~至]\s*(\d{1,2})/.exec(name);
  if (ranged) return `${ranged[1]}.${Number(ranged[2])}-${Number(ranged[3])}`;
  const year = /(?:^|[^\d])(20\d{2})(?![\d.])/.exec(name);
  return year ? year[1] : undefined;
}

/** 两份文件的主体清单有没有交集。 */
function sharedEntity(a?: string[], b?: string[]): string | undefined {
  if (!a?.length || !b?.length) return undefined;
  const right = new Set(b.map((v) => v.trim()).filter(Boolean));
  return a.map((v) => v.trim()).find((v) => v && right.has(v));
}

function makeLabel(key: string, period?: string) {
  if (key && period && key !== period) return `${key} · ${period}`;
  return key || period || "未命名";
}

/**
 * 把一批已识别的文件配成组。
 *
 * 同一个配对键下若有多份余额表或多份序时账（同名不同版本这类），
 * 只取第一份配上，其余留在未配对里让用户处理——**不猜**。
 */
export function pairLedgerFiles(files: PairingFile[]): PairedGroup[] {
  const tbs = files.filter((f) => f.kind === "tb");
  const jes = files.filter((f) => f.kind === "je");
  const usedJe = new Set<string>();
  const groups: PairedGroup[] = [];

  for (const tb of tbs) {
    const number = leadingNumber(tb.path);
    const period = periodTag(tb.path);
    let matched: PairingFile | undefined;
    const reasons: string[] = [];

    if (number) {
      // 编号相同的候选里，再按期间挑——06 套一年两段全靠这一步分开。
      const sameNumber = jes.filter(
        (je) => !usedJe.has(je.path) && leadingNumber(je.path) === number,
      );
      const samePeriod = sameNumber.filter((je) => periodTag(je.path) === period);
      matched = samePeriod[0] ?? (sameNumber.length === 1 ? sameNumber[0] : undefined);
      if (matched) {
        reasons.push(`文件名编号 ${number}`);
        if (period && periodTag(matched.path) === period)
          reasons.push(`期间 ${period}`);
        else if (sameNumber.length > 1)
          reasons.push("同编号有多份序时账，期间对不上");
      }
    }
    if (!matched) {
      const byEntity = jes.find(
        (je) => !usedJe.has(je.path) && sharedEntity(tb.entities, je.entities),
      );
      if (byEntity) {
        matched = byEntity;
        reasons.push(`主体 ${sharedEntity(tb.entities, byEntity.entities)}`);
      }
    }
    if (matched) usedJe.add(matched.path);

    // 主体两边都识别出来了却对不上，多半配错了，得让用户看一眼。
    const conflict =
      matched &&
      tb.entities?.length &&
      matched.entities?.length &&
      !sharedEntity(tb.entities, matched.entities);
    if (conflict) reasons.push("两边主体不同");

    groups.push({
      id: tb.path,
      label: makeLabel(number ?? stem(tb.path), period),
      tb,
      je: matched,
      reasons: matched ? reasons : ["没有找到对应的序时账"],
      needsReview: !matched || Boolean(conflict) || reasons.length === 0,
    });
  }

  // 没被认领的序时账也要列出来——用户可能是余额表还没拖进来。
  for (const je of jes) {
    if (usedJe.has(je.path)) continue;
    const number = leadingNumber(je.path);
    groups.push({
      id: je.path,
      label: makeLabel(number ?? stem(je.path), periodTag(je.path)),
      je,
      reasons: ["没有找到对应的科目余额表"],
      needsReview: true,
    });
  }

  // 待确认的排前面：用户的注意力应该花在这些上，对好的往下沉。
  return groups.sort((a, b) => {
    if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1;
    return a.label.localeCompare(b.label, "zh-CN", { numeric: true });
  });
}

/**
 * 把某一组的序时账换成另一份。
 *
 * 换过去的那份若已被别的组占着，两组**对调**——直接覆盖会让另一组凭空少一份
 * 文件，用户改一处坏一处。选「不配对」时传 undefined。
 */
export function reassignJe(
  groups: PairedGroup[],
  groupId: string,
  jePath: string | undefined,
): PairedGroup[] {
  const target = groups.find((group) => group.id === groupId);
  if (!target) return groups;
  const incoming = jePath
    ? groups.find((group) => group.je?.path === jePath)
    : undefined;
  const previous = target.je;
  return groups.map((group) => {
    if (group.id === groupId) {
      const je = jePath
        ? (incoming?.je ?? group.je)
        : undefined;
      return {
        ...group,
        je,
        reasons: je ? ["手工指定"] : ["没有找到对应的序时账"],
        needsReview: !je,
      };
    }
    if (incoming && group.id === incoming.id) {
      return {
        ...group,
        je: previous,
        reasons: previous ? ["与另一组对调"] : ["没有找到对应的序时账"],
        needsReview: !previous,
      };
    }
    return group;
  });
}
