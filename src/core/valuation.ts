// 自社の過去バリュエーションに基づく評価。
//
// 配信されるプロファイルには株価が入っていない。EPS/BPS と過去の分位グリッドだけを
// 受け取り、現在のPER/PBRはここで「株価 ÷ EPS」として計算して分位上の位置を引く。
// おかげでザラ場中に株価が動けば評価もその場で動く(バッチの鮮度に縛られない)。
//
// 生成側(swing/valuation/profile.py の percentile_from_grid)と同じ計算をする必要が
// あるため、両方に同じケースのテストを置いている。

export interface ValuationProfile {
  v: number;
  code: string;
  name: string;
  /** 評価の基準日。null は評価できるデータが無いことを表す。 */
  as_of: string | null;
  src: string;
  eps: number | null;
  bps: number | null;
  roe: number | null;
  /** 0%〜100%を等間隔に刻んだ分位点(21個)。履歴不足なら null。 */
  per_q: number[] | null;
  pbr_q: number[] | null;
  rel_q: number[] | null;
  mkt_per: number | null;
  /** [年, 最小, 中央, 最大] */
  per_y: [number, number, number, number][];
  pbr_y: [number, number, number, number][];
  /** ROEから説明される妥当PBRとの乖離。関係が弱ければ null(何も語らない)。 */
  roe_pbr: {
    fair: number; gap: number; r2: number; n: number;
    /** "regression"=自社時系列の回帰 / "ratio"=自社平均のPBR÷ROE倍率。古い版には無い。 */
    method?: 'regression' | 'ratio';
  } | null;
  cov: {
    years_max: number;
    span: [number, number] | null;
    span_years: number;
    obs: number;
    price_obs: number;
    records: number;
    known_from_estimated: boolean;
    missing: string[];
  };
}

/**
 * 分位グリッド上での位置(0〜100)。両端を超える値は 0 / 100 で頭打ちにする。
 * 生成側の percentile_from_grid と同一の計算。
 */
export function percentileFromGrid(grid: number[], value: number): number {
  const n = grid.length;
  if (n < 2 || !Number.isFinite(value)) return NaN;
  if (value <= grid[0]) return 0;
  if (value >= grid[n - 1]) return 100;
  let i = 0;
  for (let k = 0; k < n - 1; k += 1) {
    if (grid[k] <= value) i = k;
    else break;
  }
  const lo = grid[i];
  const hi = grid[i + 1];
  const frac = hi === lo ? 0 : (value - lo) / (hi - lo);
  return ((i + frac) / (n - 1)) * 100;
}

export interface Metric {
  key: 'per' | 'pbr';
  label: string;
  /** 現在値。分母(EPS/BPS)が無い・0以下なら null。 */
  value: number | null;
  /** 自己レンジ内の位置(0〜100)。グリッドが無ければ null。 */
  percentile: number | null;
  low: number | null;
  median: number | null;
  high: number | null;
  /** 値が出せない理由(赤字など)。表示して黙って隠さない。 */
  note: string | null;
}

function metric(key: 'per' | 'pbr', label: string, price: number | null,
                denom: number | null, grid: number[] | null,
                negativeNote: string): Metric {
  const base: Metric = {
    key, label, value: null, percentile: null,
    low: grid ? grid[0] : null,
    median: grid ? grid[Math.floor((grid.length - 1) / 2)] : null,
    high: grid ? grid[grid.length - 1] : null,
    note: null,
  };
  if (denom === null || denom === undefined) return { ...base, note: 'データなし' };
  // 赤字(EPSが負)ではPERが定義できない。「割高」ではなく「評価できない」。
  if (denom <= 0) return { ...base, note: negativeNote };
  if (price === null || !Number.isFinite(price)) return { ...base, note: '現在値なし' };
  const value = price / denom;
  return {
    ...base,
    value,
    percentile: grid ? percentileFromGrid(grid, value) : null,
    note: grid ? null : '履歴不足',
  };
}

/** 現在株価とプロファイルから、表示する指標を組み立てる。 */
export function metrics(profile: ValuationProfile, price: number | null): Metric[] {
  return [
    metric('per', 'PER', price, profile.eps, profile.per_q, '赤字のため算出不可'),
    metric('pbr', 'PBR', price, profile.bps, profile.pbr_q, '純資産がマイナス'),
  ];
}

/**
 * パーセンタイルを誤読しようのない日本語にする。
 *
 * 「下位99%」のような書き方は、レンジ上端にいるのに「下位」と読めてしまう。
 * 何と比べて高いのかを明示する。
 */
export function percentileText(percentile: number | null): string {
  if (percentile === null || !Number.isFinite(percentile)) return '';
  return `過去の${percentile.toFixed(0)}%より高い`;
}

/**
 * 自己レンジ内の位置を短い日本語にする。
 * 「割安」「買い」といった断定は使わない。位置を述べるだけに留める。
 */
export function positionLabel(percentile: number | null): string {
  if (percentile === null || !Number.isFinite(percentile)) return '—';
  if (percentile < 10) return '過去最安圏';
  if (percentile < 25) return '下位';
  if (percentile < 45) return 'やや下位';
  if (percentile <= 55) return '中位';
  if (percentile <= 75) return 'やや上位';
  if (percentile <= 90) return '上位';
  return '過去最高圏';
}

export type GapVerdict = 'cheap' | 'fair' | 'rich';

/**
 * ROEから説明される妥当PBRとの乖離の解釈。
 * ROE低下で説明できるPBR低下を「割安」と呼ばないための判定。
 */
export function gapVerdict(gapPct: number): GapVerdict {
  if (gapPct <= -15) return 'cheap';
  if (gapPct >= 15) return 'rich';
  return 'fair';
}

/**
 * 妥当PBRの推定根拠。決算が4〜5期しかない銘柄では、日次PBRの変動の大半が
 * 「同じROEの中での値動き」になり自由な傾きの回帰が通らないため、傾きを理論から
 * 固定した比率法(PBRはROEに比例する)に落ちる。どちらで出したかは表示する。
 */
export function methodText(m: ValuationProfile['roe_pbr']): string {
  if (!m) return '';
  if (m.method === 'ratio') return '自社の平常倍率(PBR÷ROE)を基準';
  return `自社の時系列回帰・説明力 r²=${m.r2.toFixed(2)}`;
}

export const GAP_TEXT: Record<GapVerdict, string> = {
  cheap: 'ROEの水準から説明できるより安い',
  fair: 'ROEの水準でおおむね説明できる',
  rich: 'ROEの水準から説明できるより高い',
};

/**
 * 実際に収録できた期間。要求した窓(years_max)ではなく実測を返す。
 *
 * cov.span を持たない古いプロファイルが配信中に混ざりうるため、その場合は
 * 年次レンジから導く。フィールドが無いだけで「履歴なし」と表示してしまうと、
 * データが有るのに無いと誤解させる。
 */
export function coverage(profile: ValuationProfile): { span: [number, number] | null; years: number } {
  const cov = profile.cov ?? ({} as ValuationProfile['cov']);
  const rows = profile.per_y?.length ? profile.per_y : profile.pbr_y ?? [];
  const years = rows.map((r) => r[0]);
  const span: [number, number] | null =
    cov.span ?? (years.length ? [Math.min(...years), Math.max(...years)] : null);
  const spanYears = cov.span_years || (span ? span[1] - span[0] + 1 : 0);
  return { span, years: spanYears };
}

/** 収録期間の説明文。要求した窓ではなく実測を出す。 */
export function coverageText(profile: ValuationProfile): string {
  const { span, years } = coverage(profile);
  if (!span || years <= 0) return '履歴なし';
  return `${span[0]}〜${span[1]}年（約${years.toFixed(1)}年）`;
}

/** 精度に関わる注意書き。該当が無ければ空配列。 */
export function caveats(profile: ValuationProfile): string[] {
  // 収録年数は冒頭の基準行に出しているので、ここでは繰り返さない。
  // 4〜5年あれば足りるという前提での運用(10年前のレンジは事業構造も相場環境も
  // 変わっていて当てにならない)。
  const out: string[] = [];
  if (profile.cov.known_from_estimated) {
    out.push('決算の公表日が推定値です');
  }
  if (profile.roe_pbr === null) {
    out.push('ROEとPBRの関係が安定せず、妥当水準は算出していません');
  }
  return out;
}
