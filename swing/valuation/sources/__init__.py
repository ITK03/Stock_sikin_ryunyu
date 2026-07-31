"""過去業績の取得元。

現状は yfinance の財務諸表のみ。将来 EDINET(有報XBRL)と決算短信XBRLを足す
予定で、そのときは known_from が推定値でなく実際の公表日になる。
取得元は profile の `src` と `cov.known_from_estimated` に必ず記録する。
"""
