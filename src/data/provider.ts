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
 * - 既定: Yahoo Finance(無料・APIキー不要)。
 * - --sample 指定: 決定論的サンプル(オフライン)。外部ネットワークが無い
 *   サンドボックスでのUI確認や、コミット用JSONの生成に使う。
 *
 * 実取得(Yahoo)は外部ドメインへ到達できる環境(GitHub Actions 等)で実行する。
 */
export async function selectProvider(forceSample = false): Promise<DataProvider> {
  if (forceSample) {
    const { SampleProvider } = await import('./sample.js');
    return new SampleProvider();
  }
  const { YahooProvider } = await import('./yahoo.js');
  return new YahooProvider();
}
