// ダークなガラス調タイルに、ネオングラデの上昇ブレイクアウト矢印。
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 44 44" role="img" aria-label="資金流入株">
      <defs>
        <linearGradient id="lg-stroke" x1="6" y1="34" x2="38" y2="10" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#2ee6a6" />
        </linearGradient>
        <linearGradient id="lg-tile" x1="0" y1="0" x2="0" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#16223c" />
          <stop offset="1" stopColor="#0b1326" />
        </linearGradient>
        <filter id="lg-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect x="0.6" y="0.6" width="42.8" height="42.8" rx="13" fill="url(#lg-tile)" />
      <rect x="0.6" y="0.6" width="42.8" height="42.8" rx="13" fill="none"
        stroke="#2ee6a6" strokeOpacity="0.18" />
      <rect x="2.4" y="2.4" width="39.2" height="20" rx="11"
        fill="#ffffff" opacity="0.04" />
      <g filter="url(#lg-glow)">
        <path d="M8 31 L18.5 24 L25 27.5 L36 13"
          fill="none" stroke="url(#lg-stroke)" strokeWidth="3.2"
          strokeLinecap="round" strokeLinejoin="round" />
        <path d="M29.5 12.4 L37 11.4 L36 18.8"
          fill="none" stroke="url(#lg-stroke)" strokeWidth="3.2"
          strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
