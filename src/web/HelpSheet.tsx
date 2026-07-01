interface Props {
  topK: number;
  onClose: () => void;
}

export function HelpSheet({ topK, onClose }: Props) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sheet-head">
          <h2>指標の説明</h2>
          <button className="sheet-close" onClick={onClose} aria-label="閉じる">×</button>
        </div>

        <div className="sheet-body">
          <section>
            <h3>基本の考え方</h3>
            <p>
              <b>比率 = 売買代金 ÷ 時価総額</b>。時価総額に対して売買代金が大きいほど、
              その銘柄に資金が集中していると考えます。
            </p>
            <p>期間で見るランキングは、単発の急増ではなく『継続性』を重視して評価します。</p>
            <p className="dim">時価総額 = 終値 × 発行済株式数 / 売買代金 ≈ 終値 × 出来高</p>
          </section>

          <section>
            <h3>ランキングの種類</h3>
            <dl>
              <dt>時価総額比</dt>
              <dd>最新営業日のスナップショット。比率が大きい順。</dd>
              <dt>連日継続</dt>
              <dd>選択期間で、時価総額比の売買代金が継続的に大きい銘柄。単発の出来高急増の影響を抑え、毎日コンスタントに資金が入っているほど上位。</dd>
              <dt>全市場上位</dt>
              <dd>「連日継続」に加え、全市場の売買代金(期間平均)が上位{topK}位以内の銘柄に絞り込み。</dd>
              <dt>急増(初動)</dt>
              <dd>売買代金の増加率(SBI等と同形式)。直近1〜3日の平均売買代金が、過去25営業日平均(平常時)に対して何%増えたかで降順。2日・3日でも上位＝連日で急増が続いている＝初動。極小型株の見かけ倍率はフィルタ(売買代金の下限)で調整。データは定期更新のため、場中の急騰は反映が遅れることがある。</dd>
            </dl>
          </section>

          <section>
            <h3>その他</h3>
            <ul>
              <li>市場フィルタで市場区分(取引所)を切替。</li>
              <li>「カード / 一覧」で表示密度を切替（設定は記憶）。</li>
              <li>コピーボタン(右上のアイコン)で、表示中ランキングの上位20件の順位・コード・銘柄名をコピー。</li>
            </ul>
          </section>

          <p className="disclaimer">
            本ツールは情報提供のみを目的とし、投資勧誘ではありません。売買代金は出来高×終値による
            近似値を含みます。最終判断はご自身の責任で行ってください。
          </p>
        </div>
      </div>
    </div>
  );
}
