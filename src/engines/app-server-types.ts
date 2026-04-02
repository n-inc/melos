/**
 * JSON-RPC リクエストID
 */
export type JsonRpcId = string | number;

/**
 * JSON-RPC エラー
 */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC レスポンス（成功）
 */
export interface JsonRpcSuccessResponse {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  result: unknown;
}

/**
 * JSON-RPC レスポンス（失敗）
 */
export interface JsonRpcErrorResponse {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

/**
 * JSON-RPC クライアント→サーバーリクエスト
 */
export interface JsonRpcRequestMessage {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 通知
 */
export interface JsonRpcNotificationMessage {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC サーバー→クライアントリクエスト
 */
export interface JsonRpcServerRequestMessage {
  jsonrpc?: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

/**
 * Turn ステータス
 */
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

/**
 * 承認ポリシー
 */
export type AppServerApprovalPolicy = 'never' | 'untrusted' | 'on-failure' | 'on-request';

/**
 * サンドボックスモード（thread/start 用）
 */
export type AppServerSandboxMode = 'danger-full-access' | 'read-only' | 'workspace-write';

/**
 * エンジン公開 API 用サンドボックス設定
 */
export type AppServerSandboxPolicyOption =
  | 'dangerFullAccess'
  | 'readOnly'
  | 'workspaceWrite';

/**
 * initialize の capabilities
 */
export interface InitializeCapabilities {
  experimentalApi: boolean;
  optOutNotificationMethods?: string[] | null;
}

/**
 * initialize params
 */
export interface InitializeParams {
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
  capabilities: InitializeCapabilities | null;
}

/**
 * thread/start params
 */
export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AppServerApprovalPolicy | null;
  sandbox?: AppServerSandboxMode | null;
  personality?: 'friendly' | 'pragmatic' | 'none' | null;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
}

/**
 * thread/resume params
 */
export interface ThreadResumeParams {
  threadId: string;
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AppServerApprovalPolicy | null;
  sandbox?: AppServerSandboxMode | null;
  persistExtendedHistory: boolean;
}

/**
 * turn/start 入力
 */
export interface TextUserInput {
  type: 'text';
  text: string;
  text_elements: Array<unknown>;
}

/**
 * turn/start params
 */
export type AppServerServiceTier = 'fast' | 'flex';

export interface TurnStartParams {
  threadId: string;
  input: TextUserInput[];
  cwd?: string | null;
  approvalPolicy?: AppServerApprovalPolicy | null;
  model?: string | null;
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
  serviceTier?: AppServerServiceTier | null;
}

/**
 * turn/steer params
 */
export interface TurnSteerParams {
  threadId: string;
  input: TextUserInput[];
  expectedTurnId: string;
}

/**
 * turn/interrupt params
 */
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/**
 * review/start params
 */
export interface ReviewStartParams {
  threadId: string;
  target: { type: 'uncommittedChanges' };
}

/**
 * thread/start, thread/resume の最小レスポンス
 */
export interface ThreadStartLikeResponse {
  thread: {
    id: string;
  };
}

/**
 * turn/start の最小レスポンス
 */
export interface TurnStartResponse {
  turn: {
    id: string;
  };
}

/**
 * turn/steer の最小レスポンス
 */
export interface TurnSteerResponse {
  turnId: string;
}

/**
 * item/agentMessage/delta
 */
export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

/**
 * item/commandExecution/outputDelta
 */
export interface CommandExecutionOutputDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

/**
 * turn/completed
 */
export interface TurnCompletedNotification {
  threadId: string;
  turn: {
    id: string;
    status: TurnStatus;
    error?: { message?: string } | null;
  };
}

/**
 * item/commandExecution/requestApproval params
 */
export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
}

/**
 * item/fileChange/requestApproval params
 */
export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
}

/**
 * item/commandExecution/requestApproval 応答
 */
export interface CommandExecutionApprovalResponse {
  decision:
    | 'accept'
    | 'acceptForSession'
    | 'decline'
    | 'cancel'
    | { acceptWithExecpolicyAmendment: { execpolicy_amendment: unknown } };
}

/**
 * item/fileChange/requestApproval 応答
 */
export interface FileChangeApprovalResponse {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
}

/**
 * turn/interrupt の空オブジェクト応答
 */
export type EmptyResponse = Record<string, never>;

/**
 * text 入力の組み立て
 */
export function createTextInput(text: string): TextUserInput {
  return {
    type: 'text',
    text,
    text_elements: [],
  };
}
