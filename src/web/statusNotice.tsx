import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

// データの遅延・サンプル表示などの警告を、各タブの中ではなく最上部のバーへ集約する。
//
// タブの中に埋めていると、スクロールで流れて見えなくなる・一覧表示で場所を削られる、
// といった理由で「古いデータを見ていることに気づかないまま判断する」事故が起きうる。
// 警告だけは常に画面最上部に居座らせる。

export type NoticeTone = 'warn' | 'info';

export interface StatusNotice {
  key: string;
  text: string;
  tone: NoticeTone;
}

interface Ctx {
  notices: StatusNotice[];
  set: (key: string, notice: StatusNotice | null) => void;
}

const StatusCtx = createContext<Ctx>({ notices: [], set: () => {} });

export function StatusNoticeProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<Record<string, StatusNotice>>({});

  // set の参照は不変にする(利用側の useEffect の依存に入るため、
  // ここが毎描画で変わると登録→解除が無限に繰り返される)。
  const set = useCallback((key: string, notice: StatusNotice | null) => {
    setMap((prev) => {
      const cur = prev[key];
      if (!notice) {
        if (!cur) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (cur && cur.text === notice.text && cur.tone === notice.tone) return prev;
      return { ...prev, [key]: notice };
    });
  }, []);

  const notices = useMemo(() => Object.values(map), [map]);
  const value = useMemo(() => ({ notices, set }), [notices, set]);
  return <StatusCtx.Provider value={value}>{children}</StatusCtx.Provider>;
}

export function useStatusNotices(): StatusNotice[] {
  return useContext(StatusCtx).notices;
}

/**
 * 最上部バーへ警告を出す。text が null の間は何も出さない。
 * 表示元がアンマウントされたら自動で取り下げる(隠れたタブの警告が残らない)。
 */
export function useStatusNotice(key: string, text: string | null, tone: NoticeTone = 'warn'): void {
  const { set } = useContext(StatusCtx);
  useEffect(() => {
    set(key, text ? { key, text, tone } : null);
    return () => set(key, null);
  }, [key, text, tone, set]);
}
