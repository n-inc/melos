import { MODEL_PRICING, type ModelPricing } from '../models/pricing.js';
import { resolveModel } from '../models/registry.js';

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  cost: number;
}

export interface TokenUsageEntry {
  role: string;
  model: string;
  pricingModel?: string;
  input: number;
  output: number;
  cached?: number;
}

export interface TokenUsageSnapshot {
  total: TokenUsage;
  byRole: Record<string, TokenUsage & { model: string }>;
}

export class TokenTracker {
  private byRole = new Map<string, TokenUsage & { model: string; pricingModel: string }>();

  record(entry: TokenUsageEntry): void {
    const previous = this.byRole.get(entry.role) ?? {
      model: entry.model,
      pricingModel: entry.pricingModel ?? resolveModel(entry.model).pricingKey,
      input: 0,
      output: 0,
      cached: 0,
      cost: 0,
    };

    const next: TokenUsage & { model: string; pricingModel: string } = {
      ...previous,
      model: entry.model,
      pricingModel: entry.pricingModel ?? previous.pricingModel,
      input: previous.input + Math.max(0, Math.floor(entry.input)),
      output: previous.output + Math.max(0, Math.floor(entry.output)),
      cached: previous.cached + Math.max(0, Math.floor(entry.cached ?? 0)),
      cost: 0,
    };

    next.cost = estimateCost(next.pricingModel, next.input, next.output);
    this.byRole.set(entry.role, next);
  }

  getTotal(): { input: number; output: number; cached: number } {
    let input = 0;
    let output = 0;
    let cached = 0;
    for (const usage of this.byRole.values()) {
      input += usage.input;
      output += usage.output;
      cached += usage.cached;
    }
    return { input, output, cached };
  }

  getByRole(): Record<string, TokenUsage & { model: string }> {
    return Object.fromEntries(
      Array.from(this.byRole.entries(), ([role, usage]) => [
        role,
        {
          model: usage.model,
          input: usage.input,
          output: usage.output,
          cached: usage.cached,
          cost: usage.cost,
        },
      ])
    );
  }

  getEstimatedCost(): number {
    let cost = 0;
    for (const usage of this.byRole.values()) {
      cost += usage.cost;
    }
    return Number(cost.toFixed(6));
  }

  getSnapshot(): TokenUsageSnapshot {
    const byRole = this.getByRole();
    const total = this.getTotal();
    return {
      total: {
        ...total,
        cost: this.getEstimatedCost(),
      },
      byRole,
    };
  }
}

function estimateCost(model: string, input: number, output: number): number {
  const pricing = resolvePricing(model);
  const inputCost = (input / 1_000_000) * pricing.inputPer1M;
  const outputCost = (output / 1_000_000) * pricing.outputPer1M;
  return Number((inputCost + outputCost).toFixed(6));
}

function resolvePricing(model: string): ModelPricing {
  const exact = MODEL_PRICING[model];
  if (exact) {
    return exact;
  }

  const lower = model.toLowerCase();
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(key.toLowerCase())) {
      return pricing;
    }
  }

  // Safe default (Sonnet-tier) when unknown.
  return MODEL_PRICING.sonnet;
}
