import { isCodexFamily, resolveModelEffort, resolveModelEngine } from './registry.js';

export type ModelRole = 'planner' | 'worker' | 'validator' | 'research';

export interface ModelAssignment {
  role: ModelRole;
  model: string;
  engine: 'claude' | 'codex';
  effort: string;
}

export interface ModelRouterConfig {
  assignments: Record<ModelRole, string>;
  escalationPolicy?: {
    enabled: boolean;
    maxEscalations: number;
    chain: Record<string, string>;
  };
}

export function isCodexModel(model: string | undefined | null): boolean {
  return isCodexFamily(model);
}

export class ModelRouter {
  private readonly assignments: Record<ModelRole, string>;
  private readonly escalationPolicy: NonNullable<ModelRouterConfig['escalationPolicy']>;
  private escalationCounts: Record<ModelRole, number>;

  constructor(config: ModelRouterConfig) {
    this.assignments = { ...config.assignments };
    this.escalationPolicy = config.escalationPolicy ?? {
      enabled: false,
      maxEscalations: 0,
      chain: {},
    };
    this.escalationCounts = {
      planner: 0,
      worker: 0,
      validator: 0,
      research: 0,
    };
  }

  getModel(role: ModelRole): string {
    return this.assignments[role];
  }

  setModel(role: ModelRole, model: string): void {
    this.assignments[role] = model;
  }

  escalate(role: ModelRole): { escalated: boolean; newModel: string } {
    const current = this.assignments[role];
    if (!this.escalationPolicy.enabled) {
      return { escalated: false, newModel: current };
    }

    if (this.escalationCounts[role] >= this.escalationPolicy.maxEscalations) {
      return { escalated: false, newModel: current };
    }

    const next = this.escalationPolicy.chain[current];
    if (!next) {
      return { escalated: false, newModel: current };
    }

    this.escalationCounts[role] += 1;
    this.assignments[role] = next;
    return { escalated: true, newModel: next };
  }

  resolveEngine(model: string): 'claude' | 'codex' {
    return resolveModelEngine(model);
  }

  resolveEffort(model: string): string {
    return resolveModelEffort(model);
  }

  getAssignments(): Record<ModelRole, ModelAssignment> {
    return {
      planner: this.toAssignment('planner'),
      worker: this.toAssignment('worker'),
      validator: this.toAssignment('validator'),
      research: this.toAssignment('research'),
    };
  }

  private toAssignment(role: ModelRole): ModelAssignment {
    const model = this.assignments[role];
    return {
      role,
      model,
      engine: this.resolveEngine(model),
      effort: this.resolveEffort(model),
    };
  }
}
