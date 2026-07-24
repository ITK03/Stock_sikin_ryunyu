export type MainTabKey = 'disclosures' | 'inflow' | 'swing' | 'sector';

interface Props {
  active: MainTabKey;
  onChange: (t: MainTabKey) => void;
}

// 左から: 開示 → 資金流入 → スイング → セクター。
const ITEMS: { key: MainTabKey; label: string; icon: JSX.Element }[] = [
  {
    key: 'disclosures',
    label: '開示',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
        <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M8 12h8M8 16h8M8 8h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: 'inflow',
    label: '資金流入',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
        <path d="M4 18 L10 11 L14 14 L20 6" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 6h6v6" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'swing',
    label: 'スイング',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
        {/* ローソク足(スイングトレード) */}
        <path d="M7 3v4M7 15v6M17 3v6M17 17v4" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" />
        <rect x="4.5" y="7" width="5" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
        <rect x="14.5" y="9" width="5" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    ),
  },
  {
    key: 'sector',
    label: 'セクター',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
        <rect x="3" y="3" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2.1" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2.1" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2.1" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2.1" />
      </svg>
    ),
  },
];

export function BottomTabBar({ active, onChange }: Props) {
  return (
    <nav className="bottom-tabbar" role="tablist" aria-label="メインタブ">
      <div className="bottom-tabbar-inner">
        {ITEMS.map((it) => (
          <button
            key={it.key}
            role="tab"
            aria-selected={it.key === active}
            className={it.key === active ? 'tabbar-btn active' : 'tabbar-btn'}
            onClick={() => onChange(it.key)}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
