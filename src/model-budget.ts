// Total response allowances; providers may count reasoning and visible text together.
export const knowledgeTokenBudgets = {
  evidence: 16_384,
  analysis: 16_384,
  grouping: 24_576,
  draft: 32_768,
  comparison: 32_768,
} as const;

export function boundedOutputTokens(requested: number, ...limits: unknown[]) {
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('模型输出预算必须是正整数');
  return Math.min(requested, ...limits.filter((limit): limit is number => typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0));
}

export function outputLimitMessage(tokens: number) {
  return `模型输出达到长度上限（本次 ${tokens} tokens）。思考模型可能将思考与正文一起计入额度；本次未自动重试。可降低思考强度、提高宿主或模型服务的输出额度，或分批整理后主动重试。`;
}
