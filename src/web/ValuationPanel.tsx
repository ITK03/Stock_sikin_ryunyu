import { useEffect, useState } from 'react';
import {
  GAP_TEXT,
  type Metric,
  type ValuationProfile,
  caveats,
  coverageText,
  gapVerdict,
  metrics,
  percentileText,
  positionLabel,
} from '../core/valuation';
import { fetchFirstOk } from './externalData';
import { valuationUrl } from './externalSources';

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

function Bar({ m }: { m: Metric }) {
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

export function ValuationPanel({ code, price }: Props) {
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

  return (
    <div className="val-panel">
      <p className="val-basis">
        比較対象はこの銘柄自身の過去 {coverageText(profile)}・{profile.cov.records}期ぶんの決算
      </p>

      {ms.map((m) => (
        <Bar key={m.key} m={m} />
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
            ROE低下で説明できるPBR低下は割安とみなさない判定。説明力 r²={gap.r2.toFixed(2)}
          </p>
        </div>
      )}

      {profile.per_y.length > 0 && (
        <div className="val-years">
          <div className="val-years-title">年ごとのPERレンジ</div>
          {profile.per_y.map(([y, lo, med, hi]) => (
            <div className="val-year-row" key={y}>
              <span className="val-year">{y}</span>
              <span className="val-year-range">
                {lo.toFixed(1)} 〜 {hi.toFixed(1)}
              </span>
              <span className="val-year-med">中央 {med.toFixed(1)}</span>
            </div>
          ))}
        </div>
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
