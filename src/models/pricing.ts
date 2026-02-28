export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  opus: { inputPer1M: 15.0, outputPer1M: 75.0 },
  sonnet: { inputPer1M: 3.0, outputPer1M: 15.0 },
  haiku: { inputPer1M: 0.25, outputPer1M: 1.25 },
  'gpt-5.3-codex': { inputPer1M: 2.5, outputPer1M: 10.0 },
};
