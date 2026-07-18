# 株価フィード配信(Actions取得→静的JSON→本体救済)実装仕様

背景: Streamlit Cloud(本体)のIPがYahooにレート制限され全銘柄取得が失敗した。
GitHub Actions(IP毎回変動・制限されにくい)が deploy で既に全銘柄の1年チャートを
取得しているので、そこから軽量JSONを追加出力してGitHub Pagesで配信し、
本体は「Yahoo直取得が大量失敗したときだけ」フィードで救済表示する。

## F1: Stock_sikin_ryunyu — フィードJSONの追加出力

`src/pipeline/build.ts` の buildRegion 内、bars 取得後に地域ごとに2ファイルを
public/data/ へ追加出力する。計算は新規の純粋関数モジュール
`src/core/feed.ts` に置き、`tests/feed.test.ts` でテストする。

### quotes_{jp|us}.json
```json
{ "generated_at": "ISO8601", "asOf": "YYYY-MM-DD",
  "quotes": { "7203": { "p": 3120.5, "c": 1.24 }, ... } }
```
- p = 最新barのclose、c = 直近2barのcloseから騰落率%(小数1桁丸め)。
- bar が1本しかない銘柄は c を省略。close<=0 の前日barは c 省略。

### period_returns_{jp|us}.json
```json
{ "generated_at": "ISO8601", "asOf": "YYYY-MM-DD",
  "returns": { "7203": { "3d": 2.1, "1w": 4.0, "2w": ..., "1m": ..., "3m": ..., "6m": ... }, ... } }
```
- src/core/periods.ts の PERIODS (key: tradingDays) を使い、
  close[last] / close[last - tradingDays] - 1 を%(小数2桁)で。
- 遡り先のbarが無い期間はキー省略。
- 銘柄のbars日付は昇順ソート済み前提(build.ts の bars と同じ扱い)。

実装ノート:
- 出力は writeFileSync(JSON.stringify) で build.ts の既存出力と同じ流儀。
- 既存の rankings 生成には一切影響を与えないこと。
- テスト: 合成barsで p/c/期間リターン/欠損省略を検証(既存テストの流儀に合わせる)。
- 検証: `npm run typecheck` / `npx vitest run` / `npm run build:data -- --sample`
  で public/data/quotes_jp.json 等が生成されること。

## F2: sector-monitor — 本体の救済フィード読込

制約: core/ data_source/ profiles/ は変更禁止。変更は app.py と新規 feed.py のみ。

### 新規 `feed.py`(リポジトリ直下)
```python
FEED_BASE = "https://itk03.github.io/Stock_sikin_ryunyu/data"
def load_feed_quotes(market: str) -> tuple[dict, float] | None
```
- market "JP"→quotes_jp.json / "US"→quotes_us.json を requests(timeout=6)で取得。
- 戻り値: ({ticker: (price, change_pct)}, generated_at_epoch)。JPはコード"7203"→
  ティッカー"7203.T"に変換、USはそのまま。取得失敗/パース失敗は None。
- 鮮度が2時間超なら None(古すぎる救済はしない)。
- 同様に `load_feed_periods(market)` → ({ticker: {"3d": pct, ...}}, epoch) | None。
  こちらは鮮度48時間まで許容。
- モジュール内に60秒のメモリキャッシュ(同一リラン間の多重fetch防止)。

### app.py の配線(2箇所)
1. fetch_quotes(): src.get_quotes(missing) の結果で「price が None の銘柄が
   全体の5割超」のとき load_feed_quotes(market) を呼び、None銘柄を
   フィード値で埋める(Quote の error は "feed" 等に)。市場判定は
   ティッカーに ".T" が含まれるかで良い。救済が発動したら
   store["feed_rescued"] = generated_at_epoch を立てる。
   ※fetch_quotes は market 引数を持たないため、missing の先頭ティッカーで判定。
2. ダッシュボード描画(render_live_dashboard 内 当日モード): 
   store["feed_rescued"] があれば st.info で
   「Yahoo取得が制限中のため、共有フィード(N分前)の株価を表示しています」
   を表示して同フラグを消費(pop)。
3. get_period_returns(): 実取得(src.get_period_returns)の結果が全滅
   (has_data False)のとき load_feed_periods で代替し、成功時は
   ファイル/メモリキャッシュにも保存する(source="feed"の区別は不要)。

### 検証
- python3 -m py_compile app.py feed.py
- feed.py の変換ロジック(コード→ティッカー、鮮度判定)は
  tests/ が無ければ簡易 assert スクリプトでよい(requests は monkeypatch)。

## 完了条件
1. 両リポジトリでテスト/typecheck/コンパイル全パス
2. Stock_sikin_ryunyu: --sample ビルドで4つのフィードJSONが生成される
3. sector-monitor: フィード取得失敗時に従来動作へ影響ゼロ(None安全)
