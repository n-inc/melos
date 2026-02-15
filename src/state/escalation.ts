import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * エスカレーションの種類
 */
export type EscalationType =
  | 'QUESTION'    // 質問（選択肢あり）
  | 'APPROVAL'    // 承認要求（破壊的操作等）
  | 'BLOCKER';    // ブロッカー（外部依存等）

/**
 * エスカレーションのステータス
 */
export type EscalationStatus = 'pending' | 'answered';

/**
 * 選択肢
 */
export interface EscalationOption {
  /** 選択肢のラベル（例: "A", "B", "C"） */
  label: string;
  /** 選択肢の説明 */
  description: string;
}

/**
 * 人間へのエスカレーション
 */
export interface Escalation {
  /** エスカレーションID */
  id: string;
  /** 作成時刻（ISO 8601） */
  createdAt: string;
  /** エスカレーションの種類 */
  type: EscalationType;
  /** 関連するコンテキスト（タスクID等） */
  context: string;
  /** 質問内容 */
  question: string;
  /** 選択肢（QUESTION タイプ用） */
  options?: EscalationOption[];
  /** 推奨選択肢 */
  recommendation?: string;
  /** ステータス */
  status: EscalationStatus;
  /** 人間の回答 */
  answer?: string;
  /** 回答時刻（ISO 8601） */
  answeredAt?: string;
}

/**
 * Escalation ファイルのパスを取得
 */
export function getEscalationPath(melosDir: string): string {
  return join(melosDir, 'ESCALATION.json');
}

/**
 * Escalation が存在するか確認
 */
export function escalationExists(melosDir: string): boolean {
  return existsSync(getEscalationPath(melosDir));
}

/**
 * Escalation を読み込む
 * @param melosDir .melos ディレクトリのパス
 * @returns Escalation または存在しない場合は null
 */
export async function loadEscalation(melosDir: string): Promise<Escalation | null> {
  const path = getEscalationPath(melosDir);
  if (!existsSync(path)) {
    return null;
  }

  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as Escalation;
}

/**
 * Escalation を保存する
 * @param melosDir .melos ディレクトリのパス
 * @param escalation 保存する Escalation
 */
export async function saveEscalation(
  melosDir: string,
  escalation: Escalation
): Promise<void> {
  if (!existsSync(melosDir)) {
    mkdirSync(melosDir, { recursive: true });
  }

  const path = getEscalationPath(melosDir);
  const content = JSON.stringify(escalation, null, 2) + '\n';
  await writeFile(path, content, 'utf-8');
}

/**
 * エスカレーションIDを生成
 */
export function generateEscalationId(): string {
  return `esc-${Date.now()}`;
}

/**
 * 新しい Escalation を作成する
 */
export function createEscalation(params: {
  type: EscalationType;
  context: string;
  question: string;
  options?: EscalationOption[];
  recommendation?: string;
}): Escalation {
  return {
    id: generateEscalationId(),
    createdAt: new Date().toISOString(),
    type: params.type,
    context: params.context,
    question: params.question,
    options: params.options,
    recommendation: params.recommendation,
    status: 'pending',
  };
}

/**
 * 新しい Escalation を作成する（QUESTION タイプ）
 */
export function createQuestionEscalation(params: {
  context: string;
  question: string;
  options: EscalationOption[];
  recommendation?: string;
}): Escalation {
  return createEscalation({
    type: 'QUESTION',
    ...params,
  });
}

/**
 * 新しい Escalation を作成する（APPROVAL タイプ）
 */
export function createApprovalEscalation(params: {
  context: string;
  question: string;
}): Escalation {
  return createEscalation({
    type: 'APPROVAL',
    ...params,
  });
}

/**
 * 新しい Escalation を作成する（BLOCKER タイプ）
 */
export function createBlockerEscalation(params: {
  context: string;
  question: string;
}): Escalation {
  return createEscalation({
    type: 'BLOCKER',
    ...params,
  });
}

/**
 * Escalation に回答を設定する
 * @param melosDir .melos ディレクトリのパス
 * @param answer 回答内容
 */
export async function answerEscalation(
  melosDir: string,
  answer: string
): Promise<Escalation> {
  const escalation = await loadEscalation(melosDir);
  if (!escalation) {
    throw new Error('No escalation found');
  }

  escalation.status = 'answered';
  escalation.answer = answer;
  escalation.answeredAt = new Date().toISOString();
  await saveEscalation(melosDir, escalation);
  return escalation;
}

/**
 * Escalation を削除する（クリーンアップ用）
 */
export async function clearEscalation(melosDir: string): Promise<void> {
  const path = getEscalationPath(melosDir);
  if (existsSync(path)) {
    await unlink(path);
  }
}
