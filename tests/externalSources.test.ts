import { describe, expect, it } from 'vitest';
import { rankingsUrls, sectorUrls } from '../src/web/externalSources';

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

  it('sectorUrls: rawを優先しPagesをフォールバックにする', () => {
    const [primary, fallback] = sectorUrls('JP');
    expect(primary).toContain('raw.githubusercontent.com');
    expect(fallback).toContain('itk03.github.io');
  });

  it('sectorUrls: 呼び出しごとに異なるクエリになる(同一値でCDNに当たらない)', async () => {
    const a = sectorUrls('JP', true)[0];
    await new Promise((r) => setTimeout(r, 2));
    expect(sectorUrls('JP', true)[0]).not.toBe(a);
  });
});
