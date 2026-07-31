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
  /** 月末値の系列(簡易グラフ用・最大60点)。v1 には無い。 */
  per_m?: (number | null)[];
  pbr_m?: (number | null)[];
  /** ROEから説明される妥当PBRとの乖離。関係が弱ければ null(何も語らない)。 */
  roe_pbr: {
    fair: number; gap: number; r2: number; n: number;
    /** "regression"=自社時系列の回帰 / "ratio"=自社平均のPBR÷ROE倍率。古い版には無い。 */
    method?: 'regression' | 'ratio';
  } | null;
  /** 収益性・安全性・還元。取得できない項目は null。 */
  fin?: Record<string, number | null>;
  /** 成長率(前期比と3年CAGR)。 */
  growth?: Record<string, number | null>;
  /** 年次推移(売上・営業利益は初年度=100の指数)。 */
  hist?: {
    years: number[]; rev: (number | null)[]; op: (number | null)[];
    eps: (number | null)[]; roe: (number | null)[]; eq: (number | null)[];
  };
  /** 四半期推移と前年同期比。 */
  q?: {
    labels: string[]; rev: (number | null)[]; op: (number | null)[];
    rev_yoy: (number | null)[]; op_yoy: (number | null)[];
  };
  /**
   * 決算短信XBRLから取った会社予想。アナリスト予想ではなく企業の正式な計画で、
   * 進捗率もこれが無ければ計算できない。まだ短信を拾えていない銘柄では null。
   */
  guidance?: {
    doc_id?: string;
    /** 短信の開示日。ここは推定ではなく市場が実際に知った日。 */
    known_from: string | null;
    consolidated: boolean;
    eps: number | null;
    dps: number | null;
    progress?: {
      quarter: number;
      elapsed: number;
      lead: number | null;
      verdict: 'ahead' | 'ontrack' | 'behind' | 'unknown';
      revenue?: number;
      operating_income?: number;
      ordinary_income?: number;
      net_income?: number;
    };
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


// ── 財務の読み取り ──────────────────────────────────────────────
// 数値をそのまま並べても判断できないので、「何を意味するか」を短い言葉にする。
// ただし「買い」「割安」とは言わない。事実の言い換えに留める。

export type Health = 'good' | 'ok' | 'watch' | 'unknown';

export interface Reading {
  key: string;
  label: string;
  /** 表示用の文字列。値が無ければ null。 */
  text: string | null;
  health: Health;
  /** なぜその評価なのかの一言。 */
  note?: string;
}

const pct = (v: number | null | undefined, digits = 1): string | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : `${(v * 100).toFixed(digits)}%`;

const times = (v: number | null | undefined, digits = 2): string | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : `${v.toFixed(digits)}倍`;

function band(v: number | null | undefined, good: number, watch: number,
              higherIsBetter = true): Health {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'unknown';
  if (higherIsBetter) return v >= good ? 'good' : v >= watch ? 'ok' : 'watch';
  return v <= good ? 'good' : v <= watch ? 'ok' : 'watch';
}

/** 財務の安全性。閾値は日本の事業会社で一般的に使われる水準。 */
export function safetyReadings(p: ValuationProfile): Reading[] {
  const f = p.fin ?? {};
  return [
    {
      key: 'equity_ratio', label: '自己資本比率', text: pct(f.equity_ratio, 0),
      health: band(f.equity_ratio, 0.5, 0.3),
      note: '総資産に占める自己資本。低いほど負債依存',
    },
    {
      key: 'de', label: 'D/Eレシオ', text: times(f.de),
      health: band(f.de, 0.5, 1.0, false),
      note: '有利子負債 ÷ 自己資本。1倍超で借入が重い',
    },
    {
      key: 'current_ratio', label: '流動比率', text: times(f.current_ratio, 1),
      health: band(f.current_ratio, 1.5, 1.0),
      note: '1年内に返す負債を短期資産で賄えるか',
    },
    {
      key: 'interest_cover', label: '利払い余力', text: times(f.interest_cover, 1),
      health: band(f.interest_cover, 10, 3),
      note: '営業利益が支払利息の何倍か',
    },
  ];
}

/** 収益性。 */
export function profitabilityReadings(p: ValuationProfile): Reading[] {
  const f = p.fin ?? {};
  return [
    { key: 'roe', label: 'ROE', text: pct(p.roe), health: band(p.roe, 0.1, 0.05),
      note: '自己資本に対する利益。8%が目安' },
    { key: 'op_margin', label: '営業利益率', text: pct(f.op_margin),
      health: band(f.op_margin, 0.1, 0.03), note: '本業の稼ぐ力' },
    { key: 'gross_margin', label: '粗利率', text: pct(f.gross_margin),
      health: band(f.gross_margin, 0.3, 0.15), note: '価格決定力の目安' },
    { key: 'roa', label: 'ROA', text: pct(f.roa), health: band(f.roa, 0.05, 0.02),
      note: '総資産に対する利益' },
  ];
}

/** 成長。率が出せない(赤字からの回復など)場合は null のまま。 */
export function growthReadings(p: ValuationProfile): Reading[] {
  const g = p.growth ?? {};
  return [
    { key: 'rev_yoy', label: '売上 前期比', text: pct(g.rev_yoy),
      health: band(g.rev_yoy, 0.1, 0) },
    { key: 'op_yoy', label: '営業利益 前期比', text: pct(g.op_yoy),
      health: band(g.op_yoy, 0.1, 0) },
    { key: 'eps_cagr3', label: 'EPS 3年成長', text: pct(g.eps_cagr3),
      health: band(g.eps_cagr3, 0.1, 0), note: '年率' },
  ];
}

/** 1株ネットキャッシュが時価総額に対してどれだけあるか。 */
export function netCashRatio(p: ValuationProfile, price: number | null): number | null {
  const ps = p.fin?.net_cash_ps;
  if (ps === null || ps === undefined || price === null || !price) return null;
  return ps / price;
}

/** FCF利回り・配当利回りは株価が要るのでここで計算する。 */
export function yields(p: ValuationProfile, price: number | null) {
  const f = p.fin ?? {};
  const y = (v: number | null | undefined) =>
    v === null || v === undefined || price === null || !price ? null : v / price;
  return { fcf: y(f.fcf_ps), dividend: y(f.dps) };
}


/**
 * 収益性・安全性・成長を1つずつの信号にまとめる。
 * 詳細を畳んでいても「稼げているか・危なくないか・伸びているか」だけは常に見える。
 */
export function healthSummary(p: ValuationProfile): Reading[] {
  const worst = (rows: Reading[]): Health => {
    const known = rows.filter((r) => r.health !== 'unknown');
    if (known.length === 0) return 'unknown';
    if (known.some((r) => r.health === 'watch')) return 'watch';
    if (known.some((r) => r.health === 'ok')) return 'ok';
    return 'good';
  };
  const text: Record<Health, string> = {
    good: '良好', ok: '標準的', watch: '要注意', unknown: '不明',
  };
  const prof = profitabilityReadings(p);
  const safe = safetyReadings(p);
  const grow = growthReadings(p);
  return [
    { key: 'sum_prof', label: '収益性', text: text[worst(prof)], health: worst(prof) },
    { key: 'sum_safe', label: '安全性', text: text[worst(safe)], health: worst(safe) },
    { key: 'sum_grow', label: '成長', text: text[worst(grow)], health: worst(grow) },
  ];
}

/** 前年同期比が算出できた四半期だけを返す(比較対象の無い期を空行で並べない)。 */
export function comparableQuarters(p: ValuationProfile) {
  const q = p.q;
  if (!q) return [];
  return q.labels
    .map((label, i) => ({ label, rev: q.rev_yoy[i], op: q.op_yoy[i] }))
    .filter((r) => r.rev !== null || r.op !== null);
}


// ── 会社予想と進捗率 ────────────────────────────────────────────
// 進捗率は単独では意味を持たない。第1四半期で25%は平常なので、経過率と
// 比べて初めて「上振れ/遅れ」が言える。

export const PROGRESS_TEXT: Record<string, string> = {
  ahead: '計画を上回るペース',
  ontrack: '計画どおりのペース',
  behind: '計画に対して遅れ',
  unknown: '判定できません',
};

/** 会社予想EPSから求める予想PER。実績PERより先を見ている。 */
export function forwardPer(p: ValuationProfile, price: number | null): number | null {
  const eps = p.guidance?.eps;
  if (!eps || eps <= 0 || price === null || !Number.isFinite(price)) return null;
  return price / eps;
}

/** 会社予想配当からの予想利回り。 */
export function forwardDividendYield(p: ValuationProfile, price: number | null): number | null {
  const dps = p.guidance?.dps;
  if (dps === null || dps === undefined || price === null || !price) return null;
  return dps / price;
}

export interface ProgressRow {
  label: string;
  ratio: number;
}

/** 進捗率の内訳(売上・営業利益など)。値のある項目だけ返す。 */
export function progressRows(p: ValuationProfile): ProgressRow[] {
  const pr = p.guidance?.progress;
  if (!pr) return [];
  const defs: [string, keyof typeof pr][] = [
    ['売上', 'revenue'],
    ['営業利益', 'operating_income'],
    ['経常利益', 'ordinary_income'],
    ['純利益', 'net_income'],
  ];
  return defs
    .map(([label, key]) => ({ label, ratio: pr[key] as number | undefined }))
    .filter((r): r is ProgressRow => typeof r.ratio === 'number');
}
