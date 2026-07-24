from backtest import universe


def test_excluded_tickers_not_in_universe():
    """不正OHLCの3銘柄（7944, 8303, 8919）はload_universe()の出力に含まれない。"""
    uni = universe.load_universe()
    for code in universe.EXCLUDED_TICKERS:
        assert code not in uni


def test_excluded_tickers_not_in_yf_tickers():
    tickers = universe.yf_tickers()
    for code in universe.EXCLUDED_TICKERS:
        assert f"{code}.T" not in tickers


def test_excluded_tickers_constant_matches_plan():
    assert universe.EXCLUDED_TICKERS == {
        "7944", "8303", "8919", "1773", "4392", "6740", "8103", "8227"}
