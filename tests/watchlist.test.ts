import { describe, expect, it } from 'vitest';
import { isWatched, parseWatchlist, serializeWatchlist, toggleWatch } from '../src/core/watchlist';

describe('parseWatchlist', () => {
  it('null・空文字は空配列', () => {
    expect(parseWatchlist(null)).toEqual([]);
    expect(parseWatchlist('')).toEqual([]);
    expect(parseWatchlist(undefined)).toEqual([]);
  });

  it('壊れたJSON・想定外の形は空配列', () => {
    expect(parseWatchlist('{oops')).toEqual([]);
    expect(parseWatchlist('123')).toEqual([]);
    expect(parseWatchlist('{"v":1}')).toEqual([]);
    expect(parseWatchlist('{"v":1,"codes":"7203"}')).toEqual([]);
  });

  it('v1エンベロープ形式を復元する', () => {
    expect(parseWatchlist('{"v":1,"codes":["7203","AAPL"]}')).toEqual(['7203', 'AAPL']);
  });

  it('素の配列も受け付ける', () => {
    expect(parseWatchlist('["7203"]')).toEqual(['7203']);
  });

  it('表記ゆれを正規化し、重複と不正コードを除外する', () => {
    expect(parseWatchlist('{"v":1,"codes":["6758.T"," 6758 ","aapl","7203円",42]}')).toEqual([
      '6758',
      'AAPL',
    ]);
  });
});

describe('serializeWatchlist → parseWatchlist の往復', () => {
  it('正規化された内容が保存・復元できる', () => {
    const s = serializeWatchlist(['6758.T', 'aapl', '6758']);
    expect(parseWatchlist(s)).toEqual(['6758', 'AAPL']);
  });
});

describe('toggleWatch', () => {
  it('未登録なら追加、登録済みなら削除する', () => {
    let codes: string[] = [];
    codes = toggleWatch(codes, '7203');
    expect(codes).toEqual(['7203']);
    codes = toggleWatch(codes, '13010');
    expect(codes).toEqual(['7203', '13010']);
    codes = toggleWatch(codes, '7203');
    expect(codes).toEqual(['13010']);
  });

  it('表記ゆれ(".T"付き・小文字)でも同一銘柄としてトグルする', () => {
    const codes = toggleWatch([], '6758');
    expect(toggleWatch(codes, '6758.T')).toEqual([]);
    expect(toggleWatch(['AAPL'], 'aapl')).toEqual([]);
  });

  it('不正なコードは無視して元の配列を返す', () => {
    const codes = ['7203'];
    expect(toggleWatch(codes, '')).toBe(codes);
    expect(toggleWatch(codes, null)).toBe(codes);
  });
});

describe('isWatched', () => {
  it('正規化して判定する', () => {
    expect(isWatched(['6758'], '6758.T')).toBe(true);
    expect(isWatched(['AAPL'], 'aapl')).toBe(true);
    expect(isWatched(['6758'], '7203')).toBe(false);
    expect(isWatched(['6758'], '')).toBe(false);
  });
});
