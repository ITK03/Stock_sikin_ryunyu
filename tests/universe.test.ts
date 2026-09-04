import { describe, expect, it } from 'vitest';
import { extractJpxListingUrls } from '../src/pipeline/universe';

// JPX の「東証上場銘柄一覧」はファイル本体のURLに
// `.../misc/<ハッシュ>-att/data_j.xls` という形のハッシュが入っており、
// JPX 側の都合で入れ替わる。直書きしていた tvdivq0000001vg2-att は実際に
// 404 になり、日本株のユニバースが取得できなくなっていた(CIログで確認)。
// 推測でURLを書き換えても次の入れ替えでまた壊れるので、配布ページから
// 現在のリンクを読む。ここではその抽出だけを固定する(通信はしない)。

const PAGE = 'https://www.jpx.co.jp/markets/statistics-equities/misc/01.html';

describe('extractJpxListingUrls', () => {
  it('相対パスのリンクを絶対URLに直す', () => {
    const html = '<a href="/markets/statistics-equities/misc/nlsgeu000006jvxd-att/data_j.xls">一覧</a>';
    expect(extractJpxListingUrls(html, PAGE)).toEqual([
      'https://www.jpx.co.jp/markets/statistics-equities/misc/nlsgeu000006jvxd-att/data_j.xls',
    ]);
  });

  it('ハッシュ部分が変わっても拾える(直書きに依存しない)', () => {
    const html = '<a href="./zzzz9999-att/data_j.xls">x</a>';
    expect(extractJpxListingUrls(html, PAGE)[0]).toContain('zzzz9999-att/data_j.xls');
  });

  it('xlsx でも拾う', () => {
    const html = '<a href="/a-att/data_j.xlsx">x</a>';
    expect(extractJpxListingUrls(html, PAGE)[0]).toMatch(/data_j\.xlsx$/);
  });

  it('同じリンクが複数あっても1つに畳む', () => {
    const html = '<a href="/a-att/data_j.xls">1</a><a href="/a-att/data_j.xls">2</a>';
    expect(extractJpxListingUrls(html, PAGE)).toHaveLength(1);
  });

  it('複数の候補があれば出現順に全部返す', () => {
    const html = '<a href="/a-att/data_j.xls">1</a><a href="/b-att/data_j.xlsx">2</a>';
    expect(extractJpxListingUrls(html, PAGE)).toHaveLength(2);
  });

  it('絶対URLで書かれていてもそのまま扱える', () => {
    const html = '<a href="https://www.jpx.co.jp/x-att/data_j.xls">x</a>';
    expect(extractJpxListingUrls(html, PAGE)).toEqual([
      'https://www.jpx.co.jp/x-att/data_j.xls',
    ]);
  });

  it('関係ないリンクは拾わない', () => {
    const html = '<a href="/a-att/data_e.xls">英語版</a><a href="/b.pdf">pdf</a>';
    expect(extractJpxListingUrls(html, PAGE)).toEqual([]);
  });

  it('リンクが無ければ空(呼び出し側が旧URLへ落ちる)', () => {
    expect(extractJpxListingUrls('<html><body>お知らせ</body></html>', PAGE)).toEqual([]);
  });
});
