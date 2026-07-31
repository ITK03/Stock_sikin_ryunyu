import { describe, expect, it } from 'vitest';
import { TICKER_INDEX_URL, rankingsUrls, sectorUrls } from '../src/web/externalSources';

// raw.githubusercontent.com も GitHub Pages も CDN が5分キャッシュする。
// 更新ボタンを押したのに古い内容が返る、という不具合の再発を防ぐため
// 「明示更新時だけクエリが付く」ことを固定する。
describe('データソースURLのキャッシュ破棄', () => {
  for (const [name, fn] of [
    ['rankingsUrls', rankingsUrls],
    ['sectorUrls', sectorUrls],
  ] as const) {
    describe(name, () => {
      it('既定ではクエリを付けない(通常表示ではCDNキャッシュを活かす)', () => {
        for (const u of fn('JP')) expect(u).not.toContain('?');
      });

      it('bust=true で全候補URLにクエリが付く', () => {
        const urls = fn('JP', true);
        expect(urls.length).toBeGreaterThan(0);
        for (const u of urls) expect(u).toMatch(/\?t=\d+$/);
      });

      it('JPとUSで別のファイルを指す', () => {
        expect(fn('JP')[0]).not.toBe(fn('US')[0]);
      });
    });
  }

  it('sectorUrls: rawを優先し、最後にPagesへフォールバックする', () => {
    const urls = sectorUrls('JP');
    expect(urls[0]).toContain('raw.githubusercontent.com');
    expect(urls[urls.length - 1]).toContain('itk03.github.io');
  });

  it('sectorUrls: 呼び出しごとに異なるクエリになる(同一値でCDNに当たらない)', async () => {
    const a = sectorUrls('JP', true)[0];
    await new Promise((r) => setTimeout(r, 2));
    expect(sectorUrls('JP', true)[0]).not.toBe(a);
  });
});

// セクターは main への通常コミット配信をやめ、data-sector orphanブランチへ移した
// (mainへ積むと1回3.6MBが永久履歴に残り、月630MBで増え続けるため)。
describe('セクターの配信元', () => {
  it('data-sector ブランチを最優先で読む', () => {
    expect(sectorUrls('JP')[0]).toContain('/data-sector/sector_jp.json');
    expect(sectorUrls('US')[0]).toContain('/data-sector/sector_us.json');
  });

  it('mainのコピーとPagesをフォールバックに残す(配信が止まってもアプリは動く)', () => {
    const urls = sectorUrls('JP');
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain('/main/public/data/');
    expect(urls[2]).toContain('itk03.github.io');
  });

  it('ticker_index も同じ配信元をたどる', () => {
    expect(TICKER_INDEX_URL[0]).toContain('/data-sector/ticker_index.json');
    expect(TICKER_INDEX_URL).toHaveLength(3);
  });
});
