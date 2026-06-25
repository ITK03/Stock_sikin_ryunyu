import type { PeriodKey } from './types';

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
