import type { PeriodKey, SurgeHorizon } from './types';

export interface PeriodDef {
  key: PeriodKey;
  label: string;
  /** 対象とする直近の営業日数。 */
  tradingDays: number;
}

// 「連日続いている」を測る各期間。営業日数換算(概算)。
export const PERIODS: PeriodDef[] = [
  { key: '3d', label: '3日', tradingDays: 3 },
  { key: '1w', label: '1週間', tradingDays: 5 },
  { key: '2w', label: '2週間', tradingDays: 10 },
  { key: '1m', label: '1ヶ月', tradingDays: 20 },
  { key: '3m', label: '3ヶ月', tradingDays: 60 },
  { key: '6m', label: '半年', tradingDays: 120 },
];

export const PERIOD_KEYS: PeriodKey[] = PERIODS.map((p) => p.key);

export interface SurgeDef {
  key: SurgeHorizon;
  label: string;
  /** 直近の集計営業日数。 */
  days: number;
}

// 売買代金急増(初動)の集計期間。直近N日平均を過去25営業日平均で割る。
export const SURGE_HORIZONS: SurgeDef[] = [
  { key: '1d', label: '1日', days: 1 },
  { key: '2d', label: '2日', days: 2 },
  { key: '3d', label: '3日', days: 3 },
];

/** 急増の平常時基準に使う過去営業日数(直近ウィンドウの手前)。 */
export const SURGE_BASELINE_DAYS = 25;
