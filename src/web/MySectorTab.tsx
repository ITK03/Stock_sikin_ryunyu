import { useEffect, useMemo, useState } from 'react';
import type { QuotesFile, Region, TickerIndexFile } from '../core/types';
import { scoreMySectors, type SectorScore } from '../core/mySector';
import { useLazyExternalJson } from './externalData';
import { TICKER_INDEX_URL, quotesUrls } from './externalSources';
import { SAMPLE_TICKER_INDEX } from '../data/sampleSector';
import { useMySectors } from './mySectorStorage';
import { MySectorList } from './MySectorList';
import { MySectorDetail } from './MySectorDetail';
import { MySectorIO } from './MySectorIO';

// マイセクター(ユーザー定義セクター)。一覧(ランキング)と詳細の2ビューを
// このコンポーネントが束ねる。現在値は表示中の市場(JP/US、親から受け取る)に
// 対応する quotes_*.json を使う — セクタータブの既存市場トグルに従う。

interface Props {
  market: Region;
  onSelectCode: (code: string) => void;
}

const EMPTY_SCORE: SectorScore = { changePct: 0, members: [], matched: 0, total: 0 };

export function MySectorTab({ market, onSelectCode }: Props) {
  const mySectors = useMySectors();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 作成直後のセクターだけ詳細画面を編集モードで開く(名前を付けてもらうため)。
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [ioOpen, setIoOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  // 現在値: 選択中市場のquotesのみ取得する(他マーケットの分は無駄なので取りに行かない)。
  const quotesState = useLazyExternalJson<QuotesFile>({
    cacheKey: market === 'US' ? 'ext:quotes_us' : 'ext:quotes_jp',
    urls: quotesUrls(market),
    sampleData: { quotes: {} },
    enabled: true,
  });
  // 銘柄名解決・銘柄追加のオートコンプリート用(日本株のみ)。既存タブで取得済みなら
  // メモリキャッシュを再利用するため、ここで呼んでも二重取得にはならない。
  const tickerIndexState = useLazyExternalJson<TickerIndexFile>({
    cacheKey: 'ext:ticker_index',
    urls: TICKER_INDEX_URL,
    sampleData: SAMPLE_TICKER_INDEX,
    enabled: true,
  });

  const scores = useMemo(
    () => scoreMySectors(mySectors.sectors, quotesState.data?.quotes),
    [mySectors.sectors, quotesState.data],
  );

  const selectedSector = selectedId ? mySectors.sectors.find((s) => s.id === selectedId) ?? null : null;

  // 削除等でセクターが消えたら一覧へ戻す。
  useEffect(() => {
    if (selectedId && !selectedSector) setSelectedId(null);
  }, [selectedId, selectedSector]);

  const backToList = () => {
    setSelectedId(null);
    setJustCreatedId(null);
  };

  const createSector = () => {
    const sector = mySectors.addSector('新しいセクター');
    setSelectedId(sector.id);
    setJustCreatedId(sector.id);
  };

  const handleDelete = (id: string) => {
    mySectors.removeSector(id);
    backToList();
  };

  const handleAddMember = (sectorId: string, code: string, name: string) => {
    mySectors.addMember(sectorId, code, 3);
    flash(`${name}を追加しました`);
  };

  return (
    <div className="mysec-tab">
      {selectedSector ? (
        <MySectorDetail
          sector={selectedSector}
          score={scores.get(selectedSector.id) ?? EMPTY_SCORE}
          market={market}
          tickerIndex={tickerIndexState.data}
          startEditing={selectedSector.id === justCreatedId}
          onBack={backToList}
          onSelectCode={onSelectCode}
          onRename={mySectors.renameSector}
          onDelete={handleDelete}
          onAddMember={handleAddMember}
          onRemoveMember={mySectors.removeMember}
          onSetRate={mySectors.setMemberRate}
        />
      ) : (
        <MySectorList
          sectors={mySectors.sectors}
          scores={scores}
          onOpenSector={setSelectedId}
          onCreateSector={createSector}
          onOpenIO={() => setIoOpen(true)}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}

      {ioOpen && (
        <MySectorIO
          sectors={mySectors.sectors}
          onImport={(sectors) => {
            mySectors.replaceAll(sectors);
            backToList();
          }}
          onClose={() => setIoOpen(false)}
        />
      )}
    </div>
  );
}
