import { useMemo } from 'react';
import { buildStockProfile } from '../core/crosslink';
import type { DisclosuresFeed, RankingDataset, SectorFile, TickerIndexFile } from '../core/types';
import { PERIODS } from '../core/periods';
import { useLazyExternalJson } from './externalData';
import { SECTOR_US_URL, TICKER_INDEX_URL } from './externalSources';
import { SAMPLE_SECTOR_US, SAMPLE_TICKER_INDEX } from '../data/sampleSector';
import { priceText, signedPct } from './format';
import { TierBadge } from './TierBadge';
import { DisclosureItem } from './DisclosureItem';

interface Props {
  code: string;
  rankingsJP?: RankingDataset;
  rankingsUS?: RankingDataset;
  disclosures: DisclosuresFeed | null;
  onClose: () => void;
}

const periodLabel = (key: string) => PERIODS.find((p) => p.key === key)?.label ?? key;

export function StockDetail({ code, rankingsJP, rankingsUS, disclosures, onClose }: Props) {
  // ticker_index(日本株の横断インデックス)・sector_us.json は数MB規模になり得るため、
  // 銘柄詳細を最初に開いたとき(=このコンポーネントが初めてマウントされたとき)だけ
  // 遅延fetchする。sector_us.json はセクタータブで既に取得済みならメモリキャッシュを再利用する。
  const tickerIndexState = useLazyExternalJson<TickerIndexFile>({
    cacheKey: 'ext:ticker_index',
    urls: TICKER_INDEX_URL,
    sampleData: SAMPLE_TICKER_INDEX,
    enabled: true,
  });
  const sectorUSState = useLazyExternalJson<SectorFile>({
    cacheKey: 'ext:sector_us',
    urls: SECTOR_US_URL,
    sampleData: SAMPLE_SECTOR_US,
    enabled: true,
  });

  const profile = useMemo(
    () =>
      buildStockProfile(code, {
        rankingsJP,
        rankingsUS,
        tickerIndex: tickerIndexState.data,
        sectorUS: sectorUSState.data,
        disclosures,
      }),
    [code, rankingsJP, rankingsUS, tickerIndexState.data, sectorUSState.data, disclosures],
  );

  // 所属セクター/現在値はまだ読み込み中の可能性があるので、「データなし」と誤解させない。
  const crossLoading = tickerIndexState.loading || sectorUSState.loading;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sheet-head">
          <h2>{profile ? profile.name ?? profile.code : code}</h2>
          <button className="sheet-close" onClick={onClose} aria-label="閉じる">×</button>
        </div>

        {!profile ? (
          <div className="sheet-body">
            <p className="state-sub">銘柄コードを読み取れませんでした。</p>
          </div>
        ) : (
          <div className="sheet-body">
            <section className="detail-hero">
              <span className="detail-code">{profile.code}</span>
              {profile.price === null && profile.changePct === null ? (
                <p className="dim">{crossLoading ? '読み込み中…' : '現在値・騰落率のデータなし'}</p>
              ) : (
                <div className="detail-price-row">
                  <span className="detail-price">{priceText(profile.price, profile.rankings[0]?.region ?? 'JP')}</span>
                  <span
                    className={`detail-chg ${(profile.changePct ?? 0) > 0 ? 'chg-up' : (profile.changePct ?? 0) < 0 ? 'chg-down' : 'chg-flat'}`}
                  >
                    {signedPct(profile.changePct)}
                  </span>
                </div>
              )}
            </section>

            <section>
              <h3>所属セクター / テーマ</h3>
              {profile.sectors.length === 0 ? (
                <p className="dim">{crossLoading ? '読み込み中…' : 'データなし'}</p>
              ) : (
                <ul className="detail-sectors">
                  {profile.sectors.map((s, i) => (
                    <li key={`${s.market}-${s.name}-${i}`} className="detail-sector-row">
                      <TierBadge tier={s.tier} />
                      <span className="detail-sector-name">{s.name}</span>
                      <span className="detail-sector-market">{s.market}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3>資金流入ランキング</h3>
              {profile.rankings.length === 0 ? (
                <p className="dim">データなし(いずれのランキングにも入っていません)</p>
              ) : (
                <div className="detail-rankings">
                  {profile.rankings.map((info) => (
                    <div key={info.region} className="detail-ranking-region">
                      <span className="detail-ranking-region-label">{info.region}</span>
                      <dl>
                        <dt>① 時価総額比</dt>
                        <dd>{info.ranking1 !== undefined ? `${info.ranking1}位` : 'データなし'}</dd>
                        <dt>② 連日継続</dt>
                        <dd>
                          {info.ranking2.length === 0
                            ? 'データなし'
                            : info.ranking2
                                .map((h) => `${periodLabel(h.period)} ${h.rank}位`)
                                .join(' / ')}
                        </dd>
                        <dt>③ 全市場上位</dt>
                        <dd>
                          {info.ranking3.length === 0
                            ? 'データなし'
                            : info.ranking3
                                .map((h) => `${periodLabel(h.period)} ${h.rank}位`)
                                .join(' / ')}
                        </dd>
                      </dl>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3>最新の開示</h3>
              {profile.disclosures.length === 0 ? (
                <p className="dim">データなし</p>
              ) : (
                <ul className="disc-list detail-disc-list">
                  {profile.disclosures.slice(0, 20).map((d) => (
                    <DisclosureItem key={d.id} d={d} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
