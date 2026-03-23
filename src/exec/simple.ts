import { continueUntilPass, customPolicy, stopDecision } from './policies.js';
import { customEvaluator } from './evaluators.js';
import { createRecipe, type RecipeDefinition } from './recipe.js';

export interface SimpleRecipeOptions {
  prompt: string;
  model?: string;
  cwd?: string;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export function createSimpleRecipe(options: SimpleRecipeOptions): RecipeDefinition {
  return createRecipe({
    prompt: options.prompt,
    context: [],
    run: {
      engine: 'auto',
      model: options.model,
      cwd: options.cwd,
      effort: options.effort,
    },
    evaluate: customEvaluator(({ assistantText }) => ({
      ok: true,
      status: 'pass',
      summary: assistantText.trim() || 'prompt executed',
      output: assistantText,
    })),
    policy: customPolicy(({ observation }) => stopDecision({
      success: true,
      summary: observation.summary,
    })),
    limits: {
      maxIterations: 1,
    },
  });
}

export { continueUntilPass };
