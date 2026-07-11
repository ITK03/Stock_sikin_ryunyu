import { useCallback, useEffect, useState } from 'react';

// 他リポジトリ(Stock_open_news / sector-monitor)が公開する JSON を取得する共通ロジック。
// - 候補URLを順に試し、失敗したら次へ。全滅したらエラーを呼び出し側へ伝える。
// - サンプルモード(?sample=1)ではネットワークを使わず、バンドル済みサンプルJSONを返す
//   (オフライン開発用。既存の `--sample` ビルドと同じ考え方をランタイム側にも用意したもの)。
//
// 2種類のキャッシュ戦略を使い分ける:
//  - useExternalJson: sessionStorage キャッシュ(数分)。開示のような小さいデータ向け。
//  - useLazyExternalJson: モジュールスコープのメモリキャッシュのみ(+ enabled による遅延実行)。
//    セクター/ticker_index のような数MB規模になり得るデータ向け。sessionStorage は
//    容量超過で失敗しうるため使わない(HTTPキャッシュ・メモリキャッシュに任せる)。

const DEFAULT_TTL_MS = 3 * 60 * 1000; // 数分キャッシュ

/** URLクエリ `?sample=1` でサンプルモードを明示的に有効化する。 */
export function isSampleMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('sample') === '1';
  } catch {
    return false;
  }
}

interface CacheEnvelope<T> {
  t: number; // 取得時刻(epoch ms)
  v: T;
}

function sessionCacheGet<T>(key: string, ttlMs: number): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const env = JSON.parse(raw) as Partial<CacheEnvelope<T>> | null;
    // 破損データ(形が違う・tが数値でない等)はキャッシュ無し扱いにして捨てる。
    if (env === null || typeof env !== 'object' || typeof env.t !== 'number' || !('v' in env) || env.v == null) {
      sessionStorage.removeItem(key);
      return null;
    }
    if (Date.now() - env.t > ttlMs) return null;
    return env.v as T;
  } catch {
    // JSONパース失敗など。壊れたエントリは次回のために削除を試みる。
    try {
      sessionStorage.removeItem(key);
    } catch {
      // sessionStorage 自体が使えない環境では何もしない。
    }
    return null;
  }
}

function sessionCacheSet<T>(key: string, v: T): void {
  try {
    const env: CacheEnvelope<T> = { t: Date.now(), v };
    sessionStorage.setItem(key, JSON.stringify(env));
  } catch {
    // 容量超過・利用不可でも致命的ではないので無視する(大きいデータでは特に起こりうる)。
  }
}

/** 1候補あたりの取得タイムアウト。応答しないURLで次の候補へのフォールバックが止まるのを防ぐ。 */
const FETCH_TIMEOUT_MS = 15 * 1000;

/**
 * 候補URLを順に試し、最初に成功した JSON を返す。全滅時は最後のエラーを投げる。
 * 各候補は AbortController でタイムアウトさせる(ハングしたURLに全体が引きずられない)。
 */
async function fetchFirstOk<T>(urls: string[]): Promise<T> {
  let lastErr: unknown = new Error('候補URLがありません');
  for (const url of urls) {
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      // JSONパース失敗(壊れたレスポンス)も次の候補URLへフォールバックする。
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e instanceof DOMException && e.name === 'AbortError' ? new Error('タイムアウト') : e;
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface ExternalDataState<T> {
  data: T | null;
  loading: boolean;
  /** 全候補URLが失敗した際のエラーメッセージ(サンプルモードでは発生しない)。 */
  error: string | null;
  /** バンドル済みサンプルデータを表示している(サンプルモード)かどうか。 */
  sample: boolean;
  /** キャッシュを無視して再取得する。 */
  reload: () => void;
}

interface UseExternalJsonOptions<T> {
  cacheKey: string;
  urls: string[];
  sampleData: T;
  ttlMs?: number;
}

/**
 * 外部データソース(sessionStorageキャッシュ付き)を取得するフック。
 * サンプルモードでは fetch を行わずバンドル済みデータを即座に返す。
 * 開示のような小さいデータ向け(数MB規模のデータには useLazyExternalJson を使う)。
 */
export function useExternalJson<T>({
  cacheKey,
  urls,
  sampleData,
  ttlMs = DEFAULT_TTL_MS,
}: UseExternalJsonOptions<T>): ExternalDataState<T> {
  const sample = isSampleMode();
  const [data, setData] = useState<T | null>(() => (sample ? sampleData : sessionCacheGet<T>(cacheKey, ttlMs)));
  const [loading, setLoading] = useState(!sample && data === null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (sample) {
      setData(sampleData);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    // nonce>0(明示的な再読込)以外はキャッシュを尊重する。
    const cached = nonce === 0 ? sessionCacheGet<T>(cacheKey, ttlMs) : null;
    if (cached) {
      setData(cached);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchFirstOk<T>(urls)
      .then((v) => {
        if (cancelled) return;
        sessionCacheSet(cacheKey, v);
        setData(v);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, nonce, sample]);

  return { data, loading, error, sample, reload };
}

// ---------------------------------------------------------------------------
// メモリキャッシュ + 遅延実行版(セクター・ticker_index など数MB規模のデータ向け)。
// ---------------------------------------------------------------------------

// モジュールスコープのキャッシュ。同じ cacheKey への同時/再フェッチを1回に集約する。
// コンポーネントをまたいで共有される(例: セクタータブで読み込んだ sector_us.json を
// 銘柄詳細シートが再利用する)ため、ページ内では実質1回しか通信しない。
const memCache = new Map<string, Promise<unknown>>();

function loadOnce<T>(cacheKey: string, urls: string[]): Promise<T> {
  const cached = memCache.get(cacheKey);
  if (cached) return cached as Promise<T>;
  const p = fetchFirstOk<T>(urls).catch((e) => {
    // 失敗時はキャッシュから外し、次回の再試行を可能にする。
    memCache.delete(cacheKey);
    throw e;
  });
  memCache.set(cacheKey, p);
  return p;
}

interface UseLazyExternalJsonOptions<T> {
  cacheKey: string;
  urls: string[];
  sampleData: T;
  /** true になった時点で初めて取得を開始する(遅延fetch)。false の間は idle 状態のまま。 */
  enabled: boolean;
}

/**
 * 数MB規模になり得る外部データ向けの遅延フック。
 * - sessionStorage は使わずモジュールスコープのメモリキャッシュのみ(容量超過を避ける)。
 * - `enabled` が true になるまでは通信しない(タブ切替・銘柄詳細を開いた時などに初めて取得)。
 * - サンプルモードでは enabled を待たずバンドル済みデータを返す(小さいためコストなし)。
 */
export function useLazyExternalJson<T>({
  cacheKey,
  urls,
  sampleData,
  enabled,
}: UseLazyExternalJsonOptions<T>): ExternalDataState<T> {
  const sample = isSampleMode();
  const [data, setData] = useState<T | null>(sample ? sampleData : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => {
    memCache.delete(cacheKey);
    setNonce((n) => n + 1);
  }, [cacheKey]);

  useEffect(() => {
    if (sample) {
      setData(sampleData);
      setLoading(false);
      setError(null);
      return;
    }
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadOnce<T>(cacheKey, urls)
      .then((v) => {
        if (cancelled) return;
        setData(v);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, enabled, sample, nonce]);

  return { data, loading, error, sample, reload };
}
