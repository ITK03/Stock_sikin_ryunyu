// 場所を取らない簡易グラフ。折れ線1本 + 現在値の点だけを描く。
//
// 軸・目盛り・凡例は出さない。数値は隣のテキストに出ているので、ここでは
// 「上がってきたのか下がってきたのか」という形だけが分かればよい。
// SVGをインラインで組み立てるので外部ライブラリは不要。

interface Props {
  values: (number | null)[];
  /** 高さ(px)。既定は行に収まる28px。 */
  height?: number;
  width?: number;
  className?: string;
  /** 塗りつぶし帯を出すか(PER/PBRのレンジ感を出したいとき)。 */
  fill?: boolean;
}

export function Sparkline({ values, height = 28, width = 96, className, fill = true }: Props) {
  const pts = values.filter((v): v is number => v !== null && Number.isFinite(v));
  // 2点未満では線にならない。無理に描かず何も出さない。
  if (pts.length < 2) return null;

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const pad = 2;
  const h = height - pad * 2;

  // null は線を切らずに前後をつなぐ(欠測月で折れ線が分断されると読みにくい)
  const coords: [number, number][] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    const x = (i / (values.length - 1)) * width;
    const y = pad + h - ((v - min) / span) * h;
    coords.push([x, y]);
  });
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = coords[coords.length - 1];
  const area = `${d} L${width},${height} L0,${height} Z`;

  return (
    <svg className={`spark ${className ?? ''}`} width={width} height={height}
      viewBox={`0 0 ${width} ${height}`} aria-hidden focusable="false">
      {fill && <path d={area} className="spark-area" />}
      <path d={d} className="spark-line" />
      <circle cx={lastX} cy={lastY} r={2.4} className="spark-dot" />
    </svg>
  );
}
