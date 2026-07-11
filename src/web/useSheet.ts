import { useEffect, useRef } from 'react';

// ボトムシート/モーダル共通の挙動。
//  - 表示中は背景(body)のスクロールを固定する(シート内スクロールと背景スクロールの混線を防ぐ)
//  - Escape キーで閉じる
//  - ブラウザ/Android の「戻る」で閉じる(履歴に1エントリ積み、popstate で閉じる。
//    ×ボタン等で閉じた場合は自分が積んだエントリを取り除くので履歴は汚れない)

// 複数シートの同時表示に備えた参照カウント(最後の1枚が閉じた時だけ解除)。
let scrollLockCount = 0;

export function useSheetBehavior(onClose: () => void): void {
  // onClose は毎レンダーで新しい関数になり得るため ref 経由で最新を呼ぶ
  // (effect 自体はマウント時に1回だけでよい)。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // --- 背景スクロール固定 ---
    scrollLockCount += 1;
    document.body.style.overflow = 'hidden';

    // --- Escape で閉じる ---
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);

    // --- 「戻る」で閉じる ---
    let pushed = false;
    let closedByPop = false;
    const onPop = () => {
      closedByPop = true;
      onCloseRef.current();
    };
    // StrictMode(devの二重マウント)で履歴エントリが二重に積まれないよう、
    // 1tick 遅延して積む(即座の mount→unmount→mount では最初の分がキャンセルされる)。
    const timer = window.setTimeout(() => {
      window.history.pushState({ __sheet: true }, '');
      pushed = true;
      window.addEventListener('popstate', onPop);
    }, 0);

    return () => {
      scrollLockCount -= 1;
      if (scrollLockCount <= 0) {
        scrollLockCount = 0;
        document.body.style.overflow = '';
      }
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(timer);
      window.removeEventListener('popstate', onPop);
      // ×ボタン・Escape 等で閉じた場合は、自分が積んだ履歴エントリを取り除く。
      if (pushed && !closedByPop) window.history.back();
    };
  }, []);
}
