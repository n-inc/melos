/**
 * Promise タグの種類
 */
export type PromiseType = 'COMPLETE' | 'TASK_DONE' | 'ESCALATE';

/**
 * Promise タグ検出結果
 */
export interface PromiseDetectionResult {
  detected: boolean;
  type: PromiseType | null;
}

/**
 * <promise>COMPLETE</promise> または単独の COMPLETE を検出する正規表現
 */
const COMPLETE_PATTERN = /<promise>COMPLETE<\/promise>|^COMPLETE$/m;

/**
 * <promise>TASK_DONE</promise> または単独の TASK_DONE を検出する正規表現
 */
const TASK_DONE_PATTERN = /<promise>TASK_DONE<\/promise>|^TASK_DONE$/m;

/**
 * <promise>ESCALATE</promise> または単独の ESCALATE を検出する正規表現
 */
const ESCALATE_PATTERN = /<promise>ESCALATE<\/promise>|^ESCALATE$/m;

/**
 * 出力から Promise タグを検出する
 *
 * 検出対象:
 * - <promise>COMPLETE</promise>
 * - <promise>TASK_DONE</promise>
 * - <promise>ESCALATE</promise>
 * - 行頭の単独 COMPLETE
 * - 行頭の単独 TASK_DONE
 * - 行頭の単独 ESCALATE
 *
 * 優先順位: ESCALATE > COMPLETE > TASK_DONE
 * - ESCALATE が検出された場合はエスカレーションでループ終了
 * - COMPLETE が検出された場合はループ終了
 * - TASK_DONE は次のイテレーションへ
 */
export function detectPromise(output: string): PromiseDetectionResult {
  // ESCALATE が最優先（人間の介入が必要な状況）
  if (ESCALATE_PATTERN.test(output)) {
    return { detected: true, type: 'ESCALATE' };
  }

  if (COMPLETE_PATTERN.test(output)) {
    return { detected: true, type: 'COMPLETE' };
  }

  if (TASK_DONE_PATTERN.test(output)) {
    return { detected: true, type: 'TASK_DONE' };
  }

  return { detected: false, type: null };
}

/**
 * Promise タグの種類に応じたメッセージを取得する
 */
export function getPromiseMessage(type: PromiseType | null): string {
  switch (type) {
    case 'ESCALATE':
      return 'Human intervention required. Exiting loop.';
    case 'COMPLETE':
      return 'All tasks completed. Exiting loop.';
    case 'TASK_DONE':
      return 'Task completed. Continuing to next iteration.';
    default:
      return 'No promise detected (possible interruption).';
  }
}
