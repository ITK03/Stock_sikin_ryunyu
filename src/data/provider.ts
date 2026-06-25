import type { DailyBar } from '../core/types';

export interface FetchOptions {
  /** 取得する直近の営業日数(半年=約120営業日 + 余裕)。 */
  lookbackDays: number;
}

export interface DataProvider {
  readonly id: string;
  fetchBars(opts: FetchOptions): Promise<DailyBar[]>;
}

/**
 * 環境に応じてプロバイダを選択する。
 * - JQUANTS_REFRESH_TOKEN もしくは JQUANTS_MAIL+JQUANTS_PASS があれば J-Quants を使用。
 * - --sample 指定、または認証情報が無ければサンプル(オフライン)プロバイダ。
 */
export async function selectProvider(forceSample = false): Promise<DataProvider> {
  const hasJQuants =
    !!process.env.JQUANTS_REFRESH_TOKEN ||
    (!!process.env.JQUANTS_MAIL && !!process.env.JQUANTS_PASS);

  if (!forceSample && hasJQuants) {
    const { JQuantsProvider } = await import('./jquants.js');
    return new JQuantsProvider();
  }
  const { SampleProvider } = await import('./sample.js');
  return new SampleProvider();
}
