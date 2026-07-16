# セクターランキング改善プラン(勢いスコア)

実装者向けの自己完結仕様。**未実装**。実装時はこの仕様に従うこと。

## 問題

セクター一覧は `change_pct`(構成銘柄の平均騰落率)の単純降順のため、
構成1〜数銘柄の極小セクターが1銘柄の急騰だけで最上位を占拠する。
実例: 「魚群探知機」= 古野電気1銘柄のみで +15.7% がダントツ1位。
本当に強いテーマ(ドローン・DRAM等、多数の銘柄が同時に上げる)が埋もれる。

## データの制約(重要)

`sector_jp.json` / `sector_us.json` の各セクター:
- `change_pct`: 全構成銘柄の平均(信頼できる全体値)
- `count`: 全構成銘柄数
- `members`: **騰落率上位30件のみ**のサンプル。count>30 のセクターでは
  上振れバイアスがあるため、members から平均や中央値を取ってはならない
  (実験済み: 中央値ベースだと IT関連403銘柄などの巨大セクターが常時上位に来る)。
  count<=30 のセクターに限り members は全数=バイアス無し。

sector-monitor 本体(データ生成側)は変更禁止。フロントエンドのみで実装する。

## 勢いスコアの定義

```
strength(s):
  if s.change_pct == null → null(ランキング末尾へ)
  base = s.change_pct × (s.count / (s.count + 8))        // 規模シュリンク
  if s.count <= 30 かつ membersに騰落率がある:
    breadth = 上昇銘柄数 / 騰落率非nullの銘柄数           // 広がり(0..1)
    base ×= (0.4 + 0.6 × breadth)
  if s.count < 3:
    base ×= 0.25                                          // 極小セクター減衰
  return base
```

設計根拠(実データ public/data/sector_jp.json で検証済み):
- 規模シュリンクだけでは魚群探知機(1銘柄+15.7%)が1位に残る(15.7×0.11=1.74)
- ×0.25減衰を加えると 0.44 となり圏外へ
- count>30 の breadth はサンプルバイアスで常に≈1になるため適用しない
- ドローン/DRAM型(15〜20銘柄が平均+4%超)は 4×0.7×0.9 ≈ 2.5 で明確に上位

## 実装タスク

### S1: `src/core/sectorStrength.ts`(新規・純粋関数)

```ts
export function sectorStrength(s: SectorEntry): number | null
```
上記の式。null安全(change_pct null → null、members空/全null → breadth省略)。

### S2: `src/web/SectorTab.tsx`

- 並び順トグルチップを追加: 「勢い」(既定) / 「騰落率」。
  状態は localStorage に保存(キー例 `sectorSort`)。
- 「勢い」= sectorStrength 降順(null は末尾)。「騰落率」= 現行 sortSectors。
- count < 3 のセクター行に補助バッジ「単一銘柄」(count==1) /「2銘柄」を表示
  (誇大な騰落率の理由が一目で分かるように)。既存の .sector-count の隣。

### S3: `src/web/HomeTab.tsx`

ホームのセクター上位表示も同じ sectorStrength 順に変更(共通関数を使う)。

### S4: テスト `tests/sectorStrength.test.ts`

- 1銘柄+15%のセクターより、15銘柄平均+4%のセクターが上に来る
- change_pct null → null
- count<=30 で breadth が効く / count>30 で members を無視する
- count<3 の減衰

### 完了条件

1. `npm run typecheck` と `npx vitest run` 全パス
2. 実データ確認: `node`等で public/data/sector_jp.json に対し新旧トップ10を
   出力し、極小セクターが上位を占めないこと(魚群探知機がトップ10圏外)
3. UI確認: セクタータブでトグルが機能し、既定が「勢い」
