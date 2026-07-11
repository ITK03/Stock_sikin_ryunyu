import { describe, expect, it } from 'vitest';
import { codesMatch, isJpCode, normalizeCode } from '../src/core/codes';

describe('normalizeCode', () => {
  it('前後空白を除去する', () => {
    expect(normalizeCode('  7203 ')).toBe('7203');
  });

  it('取引所サフィックスを除去する', () => {
    expect(normalizeCode('6758.T')).toBe('6758');
    expect(normalizeCode('aapl.US')).toBe('AAPL');
  });

  it('小文字ティッカーを大文字化する', () => {
    expect(normalizeCode('aapl')).toBe('AAPL');
  });

  it('空文字・null・undefined は null', () => {
    expect(normalizeCode('')).toBeNull();
    expect(normalizeCode('   ')).toBeNull();
    expect(normalizeCode(null)).toBeNull();
    expect(normalizeCode(undefined)).toBeNull();
  });

  it('不正な文字を含む値は null', () => {
    expect(normalizeCode('7203円')).toBeNull();
    expect(normalizeCode('N/A')).toBeNull();
  });
});

describe('isJpCode', () => {
  it('4桁・5桁の数字は日本株コードとみなす', () => {
    expect(isJpCode('7203')).toBe(true);
    expect(isJpCode('13010')).toBe(true);
  });

  it('米国ティッカーや空値は日本株コードとみなさない', () => {
    expect(isJpCode('AAPL')).toBe(false);
    expect(isJpCode('')).toBe(false);
    expect(isJpCode(undefined)).toBe(false);
  });
});

describe('codesMatch', () => {
  it('表記ゆれがあっても正規化後に一致すれば true', () => {
    expect(codesMatch('6758.T', ' 6758 ')).toBe(true);
    expect(codesMatch('aapl', 'AAPL.US')).toBe(true);
  });

  it('片方が空/不正なら false', () => {
    expect(codesMatch('', '7203')).toBe(false);
    expect(codesMatch('7203', undefined)).toBe(false);
  });
});
