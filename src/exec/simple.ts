import { createRoute, type RecipeDefinition } from './recipe.js';

export interface SimpleRouteOptions {
  prompt: string;
  model?: string;
  cwd?: string;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  serviceTier?: 'fast' | 'flex';
}

export function createSimpleRoute(options: SimpleRouteOptions): RecipeDefinition {
  return createRoute({
    run: {
      engine: 'auto',
      model: options.model,
      cwd: options.cwd,
      effort: options.effort,
      serviceTier: options.serviceTier,
    },
    workflow: {
      start: 'prompt',
      phases: {
        prompt: {
          task: options.prompt,
          next: 'stop',
        },
      },
    },
    limits: {
      maxIterations: 1,
    },
    report: { stdout: false },
  });
}
