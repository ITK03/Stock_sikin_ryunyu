import { useState } from 'react';
import { parseMySectorsForImport, serializeMySectors, type MySector } from '../core/mySector';
import { useSheetBehavior } from './useSheet';

interface Props {
  sectors: MySector[];
  onImport: (sectors: MySector[]) => void;
  onClose: () => void;
}

const FILE_NAME = 'my-sectors.json';

/** クリップボードAPIが使えない環境向けのフォールバック(資金流入タブのコピー機能と同じ方式)。 */
function copyFallback(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

/** マイセクターの入出力シート。端末内のJSONをコピー/ファイル保存/貼り付けで持ち出し・復元する。 */
export function MySectorIO({ sectors, onImport, onClose }: Props) {
  useSheetBehavior(onClose);
  const exportText = serializeMySectors(sectors);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  const copyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportText);
    } catch {
      copyFallback(exportText);
    }
    flash('コピーしました');
  };

  const saveFile = () => {
    const blob = new Blob([exportText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = FILE_NAME;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flash('ファイルを保存しました');
  };

  const runImport = () => {
    setImportError(null);
    const result = parseMySectorsForImport(importText);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    const count = result.sectors.length;
    if (!window.confirm(`現在のマイセクター(${sectors.length}件)を、読み込んだ${count}件で置き換えます。よろしいですか?`)) {
      return;
    }
    onImport(result.sectors);
    flash('読み込みました');
    setImportText('');
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sheet-head">
          <h2>マイセクターの入出力</h2>
          <button className="sheet-close" onClick={onClose} aria-label="閉じる">×</button>
        </div>
        <div className="sheet-body">
          {toast && <div className="toast" role="status">{toast}</div>}

          <section>
            <h3>書き出し</h3>
            <p className="dim">端末内に保存されているマイセクターのJSONです。コピーまたはファイル保存で持ち出せます。</p>
            <textarea className="mysec-io-textarea" readOnly value={exportText} onFocus={(e) => e.currentTarget.select()} />
            <div className="mysec-io-actions">
              <button type="button" className="filter-reset" onClick={copyExport}>コピー</button>
              <button type="button" className="filter-reset" onClick={saveFile}>ファイル保存</button>
            </div>
          </section>

          <section>
            <h3>読み込み</h3>
            <p className="dim">書き出したJSONを貼り付けて読み込みます。現在のマイセクターは置き換わります。</p>
            <textarea
              className="mysec-io-textarea"
              placeholder="ここにJSONを貼り付け"
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value);
                setImportError(null);
              }}
            />
            {importError && <p className="mysec-io-error">{importError}</p>}
            <button type="button" className="filter-reset" onClick={runImport} disabled={importText.trim() === ''}>
              読み込み
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
