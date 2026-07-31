import { useEffect, useState } from 'react';
import {
  GAP_TEXT,
  type Metric,
  type Reading,
  type ValuationProfile,
  caveats,
  coverageText,
  gapVerdict,
  comparableQuarters,
  growthReadings,
  healthSummary,
  methodText,
  metrics,
  netCashRatio,
  percentileText,
  positionLabel,
  profitabilityReadings,
  safetyReadings,
  yields,
} from '../core/valuation';
import { fetchFirstOk } from './externalData';
import { valuationUrl } from './externalSources';
import { Sparkline } from './Sparkline';

// 銘柄詳細の「バリュエーション」欄。
//
// 比較対象はその会社自身の過去だけで、他社は一切使わない。33業種のような粗い
// 分類で他社と比べても意味のある差が出ず、精度の高い類似企業を自動判定するのも
// 現実的でないため。自社の過去なら事業も会計方針も同じで、比較可能性の疑いが
// 原理的に生じない。
//
// 表示で守っていること:
//  - 収録期間は要求した窓ではなく実測を出す(yfinanceは5年しか遡れない)
//  - 赤字は「割高」ではなく「算出不可」
//  - 「割安」「買い」と断定しない。過去レンジ内の位置を述べるに留める

interface Props {
  code: string;
  price: number | null;
}

// 同じ銘柄を開き直したときに再取得しないためのメモリキャッシュ。
const cache = new Map<string, ValuationProfile | null>();

function Bar({ m, series }: { m: Metric; series?: (number | null)[] }) {
  const pct = m.percentile;
  return (
    <div className="val-metric">
      <div className="val-metric-head">
        <span className="val-metric-label">{m.label}</span>
        {m.value === null ? (
          <span className="val-metric-note">{m.note}</span>
        ) : (
          <>
            <span className="val-metric-value">{m.value.toFixed(2)}倍</span>
            {pct === null ? (
              <span className="val-metric-note">{m.note}</span>
            ) : (
              <span className="val-metric-pos">
                {positionLabel(pct)}・{percentileText(pct)}
              </span>
            )}
          </>
        )}
      </div>
      {series && series.length > 1 && (
        <div className="val-spark-row">
          <Sparkline values={series} />
          <span className="val-spark-cap">5年推移</span>
        </div>
      )}
      {pct !== null && (
        <>
          <div className="val-bar">
            <div className="val-bar-fill" style={{ width: `${pct}%` }} />
            <div className="val-bar-marker" style={{ left: `${pct}%` }} />
          </div>
          <div className="val-bar-scale">
            <span>{m.low?.toFixed(2)}</span>
            <span>中央 {m.median?.toFixed(2)}</span>
            <span>{m.high?.toFixed(2)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function Readings({ title, rows }: { title: string; rows: Reading[] }) {
  const shown = rows.filter((r) => r.text !== null);
  if (shown.length === 0) return null;
  return (
    <div className="val-block">
      <div className="val-block-title">{title}</div>
      <div className="val-readings">
        {shown.map((r) => (
          <div className={`val-reading ${r.health}`} key={r.key}>
            <span className="val-reading-label">{r.label}</span>
            <span className="val-reading-value">{r.text}</span>
            {r.note && <span className="val-reading-note">{r.note}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// 詳細の開閉は端末に保持する。既定は畳む(パネル全体が2画面分になるため)。
const DETAIL_KEY = 'valShowDetail';

export function ValuationPanel({ code, price }: Props) {
  const [showDetail, setShowDetail] = useState<boolean>(
    () => localStorage.getItem(DETAIL_KEY) === '1',
  );
  const toggleDetail = () =>
    setShowDetail((v) => {
      localStorage.setItem(DETAIL_KEY, v ? '0' : '1');
      return !v;
    });
  const [profile, setProfile] = useState<ValuationProfile | null | undefined>(
    () => (cache.has(code) ? cache.get(code) : undefined),
  );
  const [loading, setLoading] = useState(!cache.has(code));

  useEffect(() => {
    if (cache.has(code)) {
      setProfile(cache.get(code));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchFirstOk<ValuationProfile>(valuationUrl(code))
      .then((p) => {
        cache.set(code, p);
        if (!cancelled) {
          setProfile(p);
          setLoading(false);
        }
      })
      .catch(() => {
        // 404 = まだ生成されていない銘柄。ローリング生成なので数日で埋まる。
        cache.set(code, null);
        if (!cancelled) {
          setProfile(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (loading) return <p className="dim">読み込み中…</p>;

  if (!profile || !profile.as_of) {
    return (
      <p className="dim">
        この銘柄はまだ集計されていません。順次生成しているため、数日以内に表示されます。
      </p>
    );
  }

  const ms = metrics(profile, price);
  const notes = caveats(profile);
  const gap = profile.roe_pbr;
  const nc = netCashRatio(profile, price);
  const yl = yields(profile, price);
  const hist = profile.hist;
  const quarters = comparableQuarters(profile);

  return (
    <div className="val-panel">
      <p className="val-basis">
        比較対象はこの銘柄自身の過去 {coverageText(profile)}・{profile.cov.records}期ぶんの決算
      </p>

      {ms.map((m) => (
        <Bar key={m.key} m={m} series={m.key === 'per' ? profile.per_m : profile.pbr_m} />
      ))}

      {gap && (
        <div className={`val-gap ${gapVerdict(gap.gap)}`}>
          <div className="val-gap-head">
            ROEから説明される妥当PBR <strong>{gap.fair.toFixed(2)}倍</strong>
            <span className="val-gap-delta">
              {gap.gap >= 0 ? '+' : ''}
              {gap.gap.toFixed(0)}%
            </span>
          </div>
          <p className="val-gap-text">{GAP_TEXT[gapVerdict(gap.gap)]}</p>
          <p className="val-gap-sub">
            ROE低下で説明できるPBR低下は割安とみなさない判定。{methodText(gap)}
          </p>
        </div>
      )}

      {/* 詳細を畳んでいても、稼げているか・危なくないか・伸びているかは常に見える */}
      <div className="val-summary">
        {healthSummary(profile).map((r) => (
          <span className={`val-sum ${r.health}`} key={r.key}>
            {r.label} <strong>{r.text}</strong>
          </span>
        ))}
      </div>

      <button className="val-detail-btn" onClick={toggleDetail} aria-expanded={showDetail}>
        財務・成長の内訳 {showDetail ? '▲' : '▼'}
      </button>

      {showDetail && (
      <>
      <Readings title="収益性" rows={profitabilityReadings(profile)} />
      <Readings title="財務の安全性" rows={safetyReadings(profile)} />
      <Readings title="成長" rows={growthReadings(profile)} />

      {(nc !== null || yl.fcf !== null || yl.dividend !== null) && (
        <div className="val-block">
          <div className="val-block-title">株価に対する厚み</div>
          <div className="val-readings">
            {nc !== null && (
              <div className={`val-reading ${nc >= 0.3 ? 'good' : nc >= 0 ? 'ok' : 'watch'}`}>
                <span className="val-reading-label">ネットキャッシュ</span>
                <span className="val-reading-value">株価の{(nc * 100).toFixed(0)}%</span>
                <span className="val-reading-note">現金−有利子負債。多いほどPERは実質割安</span>
              </div>
            )}
            {yl.fcf !== null && (
              <div className={`val-reading ${yl.fcf >= 0.06 ? 'good' : yl.fcf > 0 ? 'ok' : 'watch'}`}>
                <span className="val-reading-label">FCF利回り</span>
                <span className="val-reading-value">{(yl.fcf * 100).toFixed(1)}%</span>
              </div>
            )}
            {yl.dividend !== null && (
              <div className="val-reading ok">
                <span className="val-reading-label">配当利回り</span>
                <span className="val-reading-value">{(yl.dividend * 100).toFixed(2)}%</span>
              </div>
            )}
          </div>
        </div>
      )}

      {hist && hist.years.length > 1 && (
        <div className="val-block">
          <div className="val-block-title">業績の推移（{hist.years[0]}〜{hist.years[hist.years.length - 1]}）</div>
          <div className="val-trends">
            {([['売上', hist.rev], ['営業利益', hist.op], ['EPS', hist.eps],
               ['ROE', hist.roe]] as const).map(([label, vals]) => (
              <div className="val-trend" key={label}>
                <span className="val-trend-label">{label}</span>
                <Sparkline values={[...vals]} width={72} height={22} fill={false} />
              </div>
            ))}
          </div>
        </div>
      )}

      {quarters.length > 0 && (
        <div className="val-block">
          <div className="val-block-title">四半期の前年同期比</div>
          <div className="val-q">
            {quarters.map((r) => (
              <div className="val-q-row" key={r.label}>
                <span className="val-q-label">{r.label}</span>
                <span className={`val-q-yoy ${(r.rev ?? 0) >= 0 ? 'up' : 'down'}`}>
                  {r.rev === null ? '—' : `売上 ${(r.rev * 100).toFixed(0)}%`}
                </span>
                <span className={`val-q-yoy ${(r.op ?? 0) >= 0 ? 'up' : 'down'}`}>
                  {r.op === null ? '—' : `営業利益 ${(r.op * 100).toFixed(0)}%`}
                </span>
              </div>
            ))}
          </div>
          <p className="val-q-note">会社予想に対する進捗率は決算短信の取り込み後に対応します。</p>
        </div>
      )}
      </>
      )}

      {notes.length > 0 && (
        <ul className="val-caveats">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
