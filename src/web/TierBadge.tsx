// セクター内での相対強さ Tier バッジ(S/A/B/C 等)。sector-monitor の tier 文字列を
// そのまま表示しつつ、既知の値(S/A/B/C)には配色を付ける。未知の値は中立色。

const KNOWN_TIER_CLASS: Record<string, string> = {
  S: 'tier-s',
  A: 'tier-a',
  B: 'tier-b',
  C: 'tier-c',
};

export function TierBadge({ tier }: { tier: string }) {
  const cls = KNOWN_TIER_CLASS[tier] ?? 'tier-other';
  return <span className={`tier-badge ${cls}`}>{tier || '—'}</span>;
}
