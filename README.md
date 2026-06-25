# 資金流入株ランキング (Stock_sikin_ryunyu)

日本株のうち「時価総額に対して売買代金が大きい」=資金流入が強い銘柄を見つけるツール。
スマホのブラウザからも確認できる静的サイトとして動作する。

## 3つのランキング

- **① 時価総額比** — 最新営業日のスナップショット。`売買代金 / 時価総額` が大きいほど上位。
- **② 連日継続** — 選択した期間(3日 / 1週間 / 2週間 / 1ヶ月 / 3ヶ月 / 半年)の**平均**で、時価総額比の売買代金が大きいほど上位。資金流入が連日続いている銘柄が浮上する。
- **③ 全市場上位** — ②に加えて、**全市場の売買代金(期間平均)上位 topK 位以内**に入る銘柄だけに絞り込み。各行に全市場での売買代金順位を表示。

指標の定義: `比率 = 売買代金 / 時価総額`(時価総額 = 終値 × 発行済株式数)。

## 構成

```
src/core/      ランキング計算エンジン(純粋関数, IO非依存, テスト対象)
src/data/      データプロバイダ(差し替え可能な seam)
  provider.ts    インターフェース + 自動選択
  jquants.ts     J-Quants API(JPX公式)プロバイダ
  sample.ts      決定論的サンプル(オフラインで全機能確認用)
src/data/yahoo.ts             Yahoo Finance(無料・キー不要)プロバイダ
src/data/sample.ts            決定論的サンプル(オフライン確認用)
src/pipeline/universe.ts      JPX上場一覧 → config/universe.json 生成
src/pipeline/build.ts         取得 → 計算 → public/data/rankings.json 出力
src/web/       React + Vite のフロントエンド(モバイル優先)
.github/workflows/deploy.yml  平日に複数回 再生成 → GitHub Pages へデプロイ
```

データは**事前生成した JSON**をフロントが読むだけ。実行時サーバー不要なので
GitHub Pages 等の静的ホスティングでスマホから閲覧できる。

## ローカル開発

```bash
npm install
npm run build:data:sample   # サンプルデータで public/data/rankings.json を生成
npm run dev                 # http://localhost:5173
npm test                    # ランキングエンジンのテスト
npm run typecheck
```

## 実データ(無料 / Yahoo Finance + JPX)

**APIキー・課金・登録は不要。** 2つの無料ソースだけを使う:

- **ユニバース**: JPX公式「東証上場銘柄一覧(data_j.xls)」→ 全市場の内国株式(プライム/スタンダード/グロース)+ 市場区分
- **株価・出来高の履歴**: Yahoo Finance chart API(認証不要、6ヶ月〜1年の日足)
- **発行済株式数(時価総額用)**: Yahoo Finance quote API

```bash
npm run universe     # JPX一覧+Yahoo株式数で config/universe.json を生成
npm run build:data   # Yahoo から取得 → ランキング計算 → JSON 出力
npm run build:web
```

### 指標の算出(無料データの制約)

| 指標 | 算出 |
| --- | --- |
| 売買代金 | `終値 × 出来高`(出来高代金の近似) |
| 時価総額 | `終値 × 発行済株式数` |
| 比率 | `売買代金 / 時価総額` |

> 真の売買代金(Σ価格×数量)は無料では銘柄横断・履歴で取得できないため、強く相関する
> `終値×出来高` を用いる。ランキング用途では実用上問題ない。より厳密にしたい場合は
> `src/data/yahoo.ts` の `barsFromChart` を別ソースに差し替えればよい(プロバイダは
> `src/data/provider.ts` の `DataProvider` インターフェースで分離済み)。

### 鮮度

Yahoo の日足は当日分も場中〜引け後に更新される(おおよそ15〜20分遅延)。
ワークフローは平日に**場中(12:30 JST)・引け直前(15:10)・引け後(15:50)**の
複数回走るので、当日の値を当日中に反映できる(1営業日以上の遅延なし)。

> 注: 開発サンドボックスは外部ドメインがegress制限で遮断されるため、実取得は
> ネットワーク開放の **GitHub Actions 上**で実行される。ローカルで実データを試す場合は
> ネットワーク制限のない環境で `npm run universe && npm run build:data` を実行する。

## スマホから見る(GitHub Pages)

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定。
2. `.github/workflows/deploy.yml` が**平日に複数回**(場中・引け前・引け後)自動で
   再生成しデプロイ。手動実行(Actions タブ → Run workflow)や push でも走る。
3. 公開URL(`https://<user>.github.io/<repo>/`)をスマホのホーム画面に追加。

シークレットや課金は不要。ローカル確認用のサンプルデータも同梱されている。

## 設計上のパラメータ

`src/pipeline/build.ts` で調整可能:

- `topN` (既定100) — 各リストの表示件数
- `topK` (既定100) — ③で「全市場上位」とみなす売買代金順位の閾値
- `minCoverage` (既定0.6) — 期間内に必要なデータ被覆率(欠損の多い銘柄を除外)
- `LOOKBACK_DAYS` (既定130) — 取得する営業日数(半年=約120営業日 + 余裕)
