import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import {
  getDefaultConfig,
  getDefaultMaxIterations,
  Orchestrator,
  type EngineType,
  type OrchestratorConfig,
} from './orchestrator.js';
import { getPendingTasks, loadPlan, type PlanTask } from './state/plan.js';

const DEFAULT_PLAN_FILE = 'PLAN.json';
const DEFAULT_PRD_FILE = 'PRD.md';
const DEFAULT_PROGRESS_FILE = 'PROGRESS.md';
const DEFAULT_DEBOUNCE_MS = 200;
const LOG_PREFIX = '[Marathon]';

export interface WatchOptions {
  engine: EngineType;
  maxIterations?: number;
  hitl?: boolean;
  /** モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.2-codex など） */
  model?: string;
  /** Codex 推論努力レベル */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

export interface WatchLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface WatchDependencies {
  cwd?: string;
  planFile?: string;
  prdFile?: string;
  progressFile?: string;
  createWatcher?: (path: string, listener: () => void) => FSWatcher;
  createOrchestrator?: (config: OrchestratorConfig) => Orchestrator;
  loadPlan?: typeof loadPlan;
  logger?: WatchLogger;
  debounceMs?: number;
}

const defaultLogger: WatchLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export async function watchPlanFile(
  options: WatchOptions,
  dependencies: WatchDependencies = {}
): Promise<void> {
  const config = getDefaultConfig({
    mode: 'default',
    maxIterations:
      options.maxIterations ?? getDefaultMaxIterations('default'),
    hitl: options.hitl ?? false,
    engine: options.engine,
    cwd: dependencies.cwd ?? process.cwd(),
    planFile: dependencies.planFile ?? DEFAULT_PLAN_FILE,
    prdFile: dependencies.prdFile ?? DEFAULT_PRD_FILE,
    progressFile: dependencies.progressFile ?? DEFAULT_PROGRESS_FILE,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  });

  const planPath = join(config.cwd, config.planFile);
  const logger = dependencies.logger ?? defaultLogger;
  const loadPlanFile = dependencies.loadPlan ?? loadPlan;
  const createWatcher =
    dependencies.createWatcher ??
    ((path: string, listener: () => void) =>
      fsWatch(path, { persistent: true }, listener));
  const createOrchestrator =
    dependencies.createOrchestrator ??
    ((orchestratorConfig: OrchestratorConfig) =>
      new Orchestrator(orchestratorConfig));
  const debounceMs = dependencies.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let lastPendingTasks: PlanTask[] = [];
  let activeOrchestrator: Orchestrator | null = null;
  let running = false;
  let pendingRun = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const refreshPendingTasks = async (): Promise<PlanTask[]> => {
    try {
      const plan = await loadPlanFile(planPath);
      const pending = getPendingTasks(plan);
      lastPendingTasks = pending;
      return pending;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`${LOG_PREFIX} PLAN.json の読み込みに失敗しました: ${message}`);
      return lastPendingTasks;
    }
  };

  const getNewPendingTasks = (pending: PlanTask[]): PlanTask[] => {
    const knownIds = new Set(lastPendingTasks.map((task) => task.id));
    return pending.filter((task) => !knownIds.has(task.id));
  };

  const handleRun = async (): Promise<void> => {
    if (running) {
      pendingRun = true;
      return;
    }

    running = true;
    activeOrchestrator = createOrchestrator(config);
    logger.info(`${LOG_PREFIX} Marathonループを開始します...`);

    try {
      await activeOrchestrator.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `${LOG_PREFIX} Marathonループ実行中にエラーが発生しました: ${message}`
      );
    } finally {
      activeOrchestrator = null;
      running = false;
      if (!closed) {
        const pending = await refreshPendingTasks();
        if (pendingRun) {
          pendingRun = false;
          if (pending.length > 0) {
            await handleRun();
          }
        }
      }
    }
  };

  const handleChange = async (): Promise<void> => {
    if (closed) {
      return;
    }

    try {
      const plan = await loadPlanFile(planPath);
      const pending = getPendingTasks(plan);
      const newTasks = getNewPendingTasks(pending);
      lastPendingTasks = pending;

      if (newTasks.length === 0) {
        return;
      }

      newTasks.forEach((task) => {
        logger.info(
          `${LOG_PREFIX} 新しいタスクを検知: id=${task.id} "${task.description}"`
        );
      });

      await handleRun();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_PREFIX} PLAN.json の読み込みに失敗しました: ${message}`);
    }
  };

  const scheduleChangeHandling = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void handleChange();
    }, debounceMs);
  };

  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
    if (activeOrchestrator) {
      activeOrchestrator.abort();
    }
  };

  await refreshPendingTasks();
  logger.info(`${LOG_PREFIX} PLAN.json を監視中... (Ctrl+C で終了)`);

  const watcher = createWatcher(planPath, scheduleChangeHandling);

  return new Promise((resolve) => {
    const handleSignal = () => {
      cleanup();
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
      resolve();
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
  });
}
