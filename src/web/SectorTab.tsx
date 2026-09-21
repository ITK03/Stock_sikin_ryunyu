import { useEffect, useState } from 'react';
import type { Region } from '../core/types';
import { MySectorTab } from './MySectorTab';
import { SectorRanking } from './SectorRanking';

// 「セクター」タブ。サブタブで「マイセクター」(ユーザー定義セクター、既定表示)と
// 「テーマ」(sector-monitor生成の既存テーマ別セクター、旧SectorTabの中身)を切り替える。
// 市場(JP/US)はサブタブ間で共有する(マイセクターも「テーマ」の市場トグルに従う)。
// 両サブタブは常時マウントしたまま hidden で切り替える(状態保持。App.tsx の
// メインタブと同じ方式)。

/** 銘柄詳細のセクター名タップ等から「このセクターを開いて」と指示するための値。 */
export interface SectorFocus {
  name: string;
  market: Region;
  /** 同じセクターに再ジャンプしても効くよう、毎回変わる値(タイムスタンプ等)。 */
  nonce: number;
}

interface Props {
  onSelectCode: (code: string) => void;
  focus?: SectorFocus | null;
}

type SectorSubTab = 'mine' | 'existing';

const SUBTAB_LABEL: Record<SectorSubTab, string> = {
  mine: 'マイセクター',
  existing: 'テーマ',
};

export function SectorTab({ onSelectCode, focus }: Props) {
  const [subTab, setSubTab] = useState<SectorSubTab>('mine');
  const [market, setMarket] = useState<Region>('JP');

  // 銘柄詳細からのジャンプ指示: 既存セクター側でしか展開できないので、
  // そちらのサブタブへ自動で切り替える。市場もジャンプ先に合わせる。
  useEffect(() => {
    if (!focus) return;
    setMarket(focus.market);
    setSubTab('existing');
  }, [focus?.nonce]);

  return (
    <div className="tab-pane">
      {/* アプリ本体の下部タブより一段軽い見た目にして、階層を分かりやすくする。 */}
      <nav className="segmented sector-view-seg" role="tablist" aria-label="セクター表示切替">
        {(Object.keys(SUBTAB_LABEL) as SectorSubTab[]).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={subTab === key}
            className={subTab === key ? 'seg-btn active' : 'seg-btn'}
            onClick={() => setSubTab(key)}
          >
            {SUBTAB_LABEL[key]}
          </button>
        ))}
      </nav>

      <div className="tab-host" hidden={subTab !== 'mine'}>
        <MySectorTab market={market} onSelectCode={onSelectCode} />
      </div>
      <div className="tab-host" hidden={subTab !== 'existing'}>
        <SectorRanking market={market} onMarketChange={setMarket} onSelectCode={onSelectCode} focus={focus} />
      </div>
    </div>
  );
}
