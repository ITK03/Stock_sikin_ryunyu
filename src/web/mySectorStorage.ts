import { useCallback, useState } from 'react';
import {
  clampRate,
  makeSectorId,
  parseMySectors,
  serializeMySectors,
  type MySector,
  type Rate,
} from '../core/mySector';
import { normalizeCode } from '../core/codes';

// マイセクターのlocalStorage永続化(端末内完結)。純ロジックは src/core/mySector.ts。
// 保有ポジション(SwingPositions.tsx)と同じ方式: プライベートモード等で
// localStorage が使えない環境向けにメモリfallbackを持つ。

const STORAGE_KEY = 'mySectors:v1';

// モジュールスコープに置くことでタブの再マウントをまたいでも維持する。
let memoryFallback: string | null = null;

function loadRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryFallback;
  }
}

function saveRaw(raw: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    memoryFallback = raw;
  }
}

export interface UseMySectors {
  sectors: MySector[];
  /** 新規セクターを作成して返す(呼び出し側で詳細画面への遷移に使う)。 */
  addSector: (name: string) => MySector;
  renameSector: (id: string, name: string) => void;
  removeSector: (id: string) => void;
  /** 既に追加済みのコードは何もしない。 */
  addMember: (sectorId: string, code: string, rate?: Rate) => void;
  removeMember: (sectorId: string, code: string) => void;
  setMemberRate: (sectorId: string, code: string, rate: Rate) => void;
  /** 入出力シートの「読み込み」用: 全セクターを丸ごと置き換える。 */
  replaceAll: (sectors: MySector[]) => void;
}

const FALLBACK_NAME = '新しいセクター';

export function useMySectors(): UseMySectors {
  const [sectors, setSectors] = useState<MySector[]>(() => parseMySectors(loadRaw()));

  const persist = useCallback((next: MySector[]) => {
    setSectors(next);
    saveRaw(serializeMySectors(next));
  }, []);

  const addSector = useCallback(
    (name: string): MySector => {
      const sector: MySector = {
        id: makeSectorId(),
        name: name.trim().slice(0, 40) || FALLBACK_NAME,
        members: [],
      };
      setSectors((prev) => {
        const next = [...prev, sector];
        saveRaw(serializeMySectors(next));
        return next;
      });
      return sector;
    },
    [],
  );

  const renameSector = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim().slice(0, 40);
      if (!trimmed) return;
      setSectors((prev) => {
        const next = prev.map((s) => (s.id === id ? { ...s, name: trimmed } : s));
        saveRaw(serializeMySectors(next));
        return next;
      });
    },
    [],
  );

  const removeSector = useCallback((id: string) => {
    setSectors((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveRaw(serializeMySectors(next));
      return next;
    });
  }, []);

  const addMember = useCallback((sectorId: string, rawCode: string, rate: Rate = 3) => {
    const code = normalizeCode(rawCode);
    if (!code) return;
    setSectors((prev) => {
      const next = prev.map((s) => {
        if (s.id !== sectorId) return s;
        if (s.members.some((m) => m.code === code)) return s; // 追加済み
        return { ...s, members: [...s.members, { code, rate: clampRate(rate) }] };
      });
      saveRaw(serializeMySectors(next));
      return next;
    });
  }, []);

  const removeMember = useCallback((sectorId: string, code: string) => {
    setSectors((prev) => {
      const next = prev.map((s) =>
        s.id === sectorId ? { ...s, members: s.members.filter((m) => m.code !== code) } : s,
      );
      saveRaw(serializeMySectors(next));
      return next;
    });
  }, []);

  const setMemberRate = useCallback((sectorId: string, code: string, rate: Rate) => {
    setSectors((prev) => {
      const next = prev.map((s) =>
        s.id === sectorId
          ? { ...s, members: s.members.map((m) => (m.code === code ? { ...m, rate: clampRate(rate) } : m)) }
          : s,
      );
      saveRaw(serializeMySectors(next));
      return next;
    });
  }, []);

  const replaceAll = useCallback((next: MySector[]) => {
    persist(next);
  }, [persist]);

  return { sectors, addSector, renameSector, removeSector, addMember, removeMember, setMemberRate, replaceAll };
}
