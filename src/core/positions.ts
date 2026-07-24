// 保有ポジション(ユーザーが手動登録する自己申告の実際の保有)の純ロジック。
// IO非依存(localStorage への読み書きは src/web 側)。検証ログ(paper_log.json、
// 自動ペーパートレードの記録)とは別物 — こちらはユーザー自身の実運用管理用。

import { normalizeCode } from './codes';

/** 保有ポジション1件。 */
export interface SwingPosition {
  id: string;
  /** 発注元の戦略ID(signals.json の strategies[].id)。任意入力の場合は空文字。 */
  strategyId: string;
  code: string;
  name: string;
  /** 取得日 'YYYY-MM-DD'。 */
  fillDate: string;
  /** 取得単価(円)。 */
  fillPrice: number;
  shares: number;
}

/** 永続化フォーマットのバージョン付きエンベロープ。 */
interface PositionsEnvelope {
  v: 1;
  positions: SwingPosition[];
}

function isValidPosition(x: unknown): x is SwingPosition {
  if (x === null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.strategyId === 'string' &&
    typeof o.code === 'string' &&
    o.code.length > 0 &&
    typeof o.name === 'string' &&
    typeof o.fillDate === 'string' &&
    typeof o.fillPrice === 'number' &&
    Number.isFinite(o.fillPrice) &&
    o.fillPrice > 0 &&
    typeof o.shares === 'number' &&
    Number.isFinite(o.shares) &&
    o.shares > 0
  );
}

/**
 * 永続化された文字列(JSON)から保有ポジション一覧を復元する。
 * 壊れたデータ・不正な要素は黙って捨てる(空配列にフォールバック)。
 */
export function parsePositions(raw: string | null | undefined): SwingPosition[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as PositionsEnvelope).positions)
      ? (parsed as PositionsEnvelope).positions
      : [];
    return arr.filter(isValidPosition);
  } catch {
    return [];
  }
}

/** 保有ポジション一覧を永続化用の文字列(JSON)へ変換する。 */
export function serializePositions(positions: SwingPosition[]): string {
  const env: PositionsEnvelope = { v: 1, positions };
  return JSON.stringify(env);
}

/** 新規ポジションのID(時刻+乱数)。 */
export function makePositionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 証券コード入力を正規化する。不正な入力は null。 */
export function normalizePositionCode(raw: string | null | undefined): string | null {
  return normalizeCode(raw);
}

/** 評価損益額(円) = (現在値 - 取得単価) × 株数。現在値不明なら null。 */
export function positionPnlAmount(pos: Pick<SwingPosition, 'fillPrice' | 'shares'>, currentPrice: number | null): number | null {
  if (currentPrice === null || !Number.isFinite(currentPrice)) return null;
  return (currentPrice - pos.fillPrice) * pos.shares;
}

/** 評価損益率(比率, 0.01 = 1%)。現在値不明・取得単価0以下なら null。 */
export function positionPnlPct(pos: Pick<SwingPosition, 'fillPrice'>, currentPrice: number | null): number | null {
  if (currentPrice === null || !Number.isFinite(currentPrice) || !(pos.fillPrice > 0)) return null;
  return currentPrice / pos.fillPrice - 1;
}
