import type { SectorEntry } from './types';

/**
 * セクターの「勢いスコア」。change_pct の単純降順だと構成1〜数銘柄の極小
 * セクターが1銘柄の急騰だけで最上位を占拠してしまう問題への対策。
 *
 * 計算式(詳細は docs/SECTOR_RANK_PLAN.md):
 * 1. 規模シュリンク: change_pct × (count / (count + 8))
 *    構成銘柄が少ないほどスコアを縮める。
 * 2. 広がり補正: count<=30(members が全数でバイアス無し)の場合のみ、
 *    上昇銘柄の割合(0.4〜1.0倍)を掛ける。count>30 は members が上位30件
 *    サンプルで上振れバイアスがあるため適用しない。
 * 3. 極小セクター減衰: count<3 の場合はさらに×0.25。
 *
 * change_pct が null のセクターは null を返す(呼び出し側でランキング末尾へ)。
 */
export function sectorStrength(s: SectorEntry): number | null {
  if (s.change_pct === null) return null;

  let base = s.change_pct * (s.count / (s.count + 8));

  if (s.count <= 30) {
    const withChange = s.members.filter((m) => m.change_pct !== null);
    if (withChange.length > 0) {
      const upCount = withChange.filter((m) => (m.change_pct as number) > 0).length;
      const breadth = upCount / withChange.length;
      base *= 0.4 + 0.6 * breadth;
    }
  }

  if (s.count < 3) {
    base *= 0.25;
  }

  return base;
}

/** sectorStrength 降順(null は末尾)でセクター一覧をソートする。 */
export function sortSectorsByStrength(sectors: SectorEntry[]): SectorEntry[] {
  return [...sectors].sort((a, b) => {
    const av = sectorStrength(a);
    const bv = sectorStrength(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });
}
