import type { DailyBar, MarketSegment } from '../core/types';
import type { DataProvider, FetchOptions } from './provider';

// J-Quants API (JPX公式) プロバイダ。
// 認証情報は環境変数で渡す:
//   JQUANTS_REFRESH_TOKEN          … リフレッシュトークン(推奨)
//   または JQUANTS_MAIL + JQUANTS_PASS … メール/パスワード
//
// データ鮮度はプランに依存する:
//   無料        … 約12週間遅延(検証/バックフィル向け)
//   Light以上   … 前営業日まで(日次運用向け)
// コードはプラン非依存。鮮度を上げたい場合はプランを変えるだけでよい。

const API = 'https://api.jquants.com/v1';

interface QuoteRow {
  Date: string;
  Code: string;
  Close: number | null;
  TurnoverValue: number | null;
}

interface ListedRow {
  Code: string;
  CompanyName: string;
  MarketCodeName?: string;
  MarketCode?: string;
}

function mapSegment(row: ListedRow): MarketSegment {
  const n = row.MarketCodeName ?? '';
  const c = row.MarketCode ?? '';
  if (n.includes('プライム') || c === '0111') return 'Prime';
  if (n.includes('スタンダード') || c === '0112') return 'Standard';
  if (n.includes('グロース') || c === '0113') return 'Growth';
  return 'Other';
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class JQuantsProvider implements DataProvider {
  readonly id = 'jquants';
  private idToken = '';

  private async authenticate(): Promise<void> {
    let refresh = process.env.JQUANTS_REFRESH_TOKEN;
    if (!refresh) {
      const res = await fetch(`${API}/token/auth_user`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mailaddress: process.env.JQUANTS_MAIL,
          password: process.env.JQUANTS_PASS,
        }),
      });
      if (!res.ok) throw new Error(`auth_user failed: ${res.status} ${await res.text()}`);
      refresh = (await res.json()).refreshToken;
    }
    const res = await fetch(`${API}/token/auth_refresh?refreshtoken=${encodeURIComponent(refresh!)}`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`auth_refresh failed: ${res.status} ${await res.text()}`);
    this.idToken = (await res.json()).idToken;
  }

  /** ページネーション(pagination_key)を辿りつつ key 配列を結合して返す。 */
  private async getAll<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let paginationKey: string | undefined;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const url = paginationKey
        ? `${API}${path}${sep}pagination_key=${encodeURIComponent(paginationKey)}`
        : `${API}${path}`;
      const res = await this.fetchWithRetry(url);
      const json = await res.json();
      if (Array.isArray(json[key])) out.push(...json[key]);
      paginationKey = json.pagination_key;
    } while (paginationKey);
    return out;
  }

  private async fetchWithRetry(url: string, attempts = 4): Promise<Response> {
    let lastErr: unknown;
    for (let a = 0; a < attempts; a++) {
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${this.idToken}` } });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** a));
          continue;
        }
        if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
        return res;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** a));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** 直近 lookbackDays 営業日の日付配列(取引カレンダー基準)。 */
  private async businessDays(lookbackDays: number): Promise<string[]> {
    const to = new Date();
    const from = new Date();
    // 営業日数より多めにカレンダーを取得(土日祝を考慮し約1.6倍)。
    from.setDate(from.getDate() - Math.ceil(lookbackDays * 1.6) - 10);
    const cal = await this.getAll<{ Date: string; HolidayDivision: string }>(
      `/markets/trading_calendar?from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`,
      'trading_calendar',
    );
    return cal
      .filter((c) => c.HolidayDivision === '1')
      .map((c) => c.Date)
      .sort()
      .slice(-lookbackDays);
  }

  /** code -> 発行済株式数。最新の財務諸表から取得(時価総額算出用)。 */
  private async sharesOutstanding(codes: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const fields = [
      'NumberOfIssuedAndOutstandingSharesAtTheEndOfFiscalYearIncludingTreasuryStock',
      'NumberOfIssuedShares',
    ];
    await mapLimit(codes, 5, async (code) => {
      try {
        const rows = await this.getAll<Record<string, string>>(
          `/fins/statements?code=${code}`,
          'statements',
        );
        for (let i = rows.length - 1; i >= 0; i--) {
          for (const f of fields) {
            const v = Number(rows[i][f]);
            if (Number.isFinite(v) && v > 0) {
              map.set(code, v);
              return;
            }
          }
        }
      } catch {
        // 取得できない銘柄は時価総額を出せないため除外される。
      }
    });
    return map;
  }

  async fetchBars(opts: FetchOptions): Promise<DailyBar[]> {
    await this.authenticate();
    const days = await this.businessDays(opts.lookbackDays);
    if (days.length === 0) return [];

    const latest = days[days.length - 1];
    const listed = await this.getAll<ListedRow>(`/listed/info?date=${latest}`, 'info');
    const meta = new Map<string, ListedRow>();
    for (const row of listed) meta.set(row.Code, row);

    const shares = await this.sharesOutstanding([...meta.keys()]);

    const perDay = await mapLimit(days, 3, (date) =>
      this.getAll<QuoteRow>(`/prices/daily_quotes?date=${date}`, 'daily_quotes'),
    );

    const bars: DailyBar[] = [];
    for (const quotes of perDay) {
      for (const q of quotes) {
        const sh = shares.get(q.Code);
        const info = meta.get(q.Code);
        if (!sh || !info || q.Close == null || q.TurnoverValue == null) continue;
        bars.push({
          date: q.Date,
          code: q.Code,
          name: info.CompanyName,
          market: mapSegment(info),
          close: q.Close,
          turnover: q.TurnoverValue,
          marketCap: q.Close * sh,
        });
      }
    }
    return bars;
  }
}
