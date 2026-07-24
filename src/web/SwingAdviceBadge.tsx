import type { SwingAdvice } from '../core/swingAdvice';

// 「今後どうしたらいいか」を1つのバッジで表す(保有継続 / 利確 / 損切り / 期限 / 手仕舞い)。
// 保有ポジション・検証ログの保有中の両方で使う共通表示。tone で配色を切り替える。

const TONE_CLASS: Record<SwingAdvice['tone'], string> = {
  up: 'swing-advice-up',
  down: 'swing-advice-down',
  warn: 'swing-advice-warn',
  neutral: 'swing-advice-neutral',
};

export function SwingAdviceBadge({ advice }: { advice: SwingAdvice }) {
  return (
    <span className={`swing-advice ${TONE_CLASS[advice.tone]}`}>
      <span className="swing-advice-label">{advice.label}</span>
      {advice.detail && <span className="swing-advice-detail">{advice.detail}</span>}
    </span>
  );
}
