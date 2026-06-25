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
src/pipeline/  取得 → 計算 → public/data/rankings.json 出力
src/web/       React + Vite のフロントエンド(モバイル優先)
.github/workflows/daily.yml  平日引け後に再生成 → GitHub Pages へデプロイ
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

## 実データ(J-Quants)に切り替える

[J-Quants](https://jpx-jquants.com/) に登録し、認証情報を環境変数で渡すだけ。コード変更は不要。

```bash
export JQUANTS_REFRESH_TOKEN=xxxxx      # リフレッシュトークン(推奨)
# または
export JQUANTS_MAIL=you@example.com
export JQUANTS_PASS=yourpassword

npm run build:data          # 認証情報があれば自動で J-Quants を使用
npm run build:web
```

### データ鮮度とプラン

ユーザー要件は「1日以上の遅延を許容しない」。プランで鮮度が決まる:

| プラン | 鮮度 | 用途 |
| --- | --- | --- |
| 無料 | 約12週間遅延 | 検証・バックフィルのみ |
| Light(約¥1,650/月)以上 | 前営業日まで | 日次運用 |

要件を満たすには **Light 以上**を推奨。コードはプラン非依存で、シークレットを
設定し直すだけで切り替わる。

> 補足: 時価総額は `終値 × 発行済株式数` で算出。発行済株式数は J-Quants の
> 財務諸表(`/fins/statements`)から取得している。プランやデータ提供状況により
> 取得方法の調整が必要な場合がある(`src/data/jquants.ts` の `sharesOutstanding`)。

## スマホから見る(GitHub Pages)

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定。
2. (実データを使う場合)**Settings → Secrets and variables → Actions** に
   `JQUANTS_REFRESH_TOKEN`(または `JQUANTS_MAIL` / `JQUANTS_PASS`)を登録。
3. `.github/workflows/daily.yml` が**平日 16:30 JST**に自動で再生成しデプロイ。
   手動実行(workflow_dispatch)や push でも走る。
4. 公開URL(`https://<user>.github.io/<repo>/`)をスマホのホーム画面に追加。

シークレット未設定でもサンプルデータでデプロイされ、UIの動作確認ができる。

## 設計上のパラメータ

`src/pipeline/build.ts` で調整可能:

- `topN` (既定100) — 各リストの表示件数
- `topK` (既定100) — ③で「全市場上位」とみなす売買代金順位の閾値
- `minCoverage` (既定0.6) — 期間内に必要なデータ被覆率(欠損の多い銘柄を除外)
- `LOOKBACK_DAYS` (既定130) — 取得する営業日数(半年=約120営業日 + 余裕)
