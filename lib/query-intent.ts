export type QueryProtocol = "all" | "mpp" | "x402";
export type QueryWindow = 0 | 1 | 7 | 30;
export type QueryIntent =
  | "cohort"
  | "wallet"
  | "autonomy"
  | "anomaly"
  | "growth"
  | "protocol_comparison"
  | "average_payment"
  | "payer_addresses"
  | "top_service"
  | "server_identities"
  | "volume"
  | "transactions";

export function protocolForQuery(question: string, selected: QueryProtocol) {
  const mentionsMpp = /\bmpp\b/i.test(question);
  const mentionsX402 = /\bx402\b|\b402\b/i.test(question);
  if (mentionsMpp && mentionsX402) return "all";
  if (mentionsMpp) return "mpp";
  if (mentionsX402) return "x402";
  return selected;
}

export function windowForQuery(question: string, selected: QueryWindow) {
  if (/\b(all[ -]?time|all history|since inception|entire history)\b/i.test(question)) return 0;
  if (/\b(24\s*(hours?|hrs?|h)|today|1\s*day|one\s*day)\b/i.test(question)) return 1;
  if (/\b(7\s*(days?|d)|one\s*week|past week|last week|this week|week)\b/i.test(question)) return 7;
  if (/\b(30\s*(days?|d)|one\s*month|past month|last month)\b/i.test(question)) return 30;
  return selected;
}

export function classifyQuery(question: string): QueryIntent {
  const text = question.toLowerCase();
  if (/\b(cohort|retention|retained|returning users?|repeat buyers?)\b/.test(text)) return "cohort";
  if (/\b(wallet|metamask|coinbase|privy|crossmint|safe|turnkey|fireblocks|circle)\b/.test(text)) return "wallet";
  if (/\b(autonom\w*|human|bots?|agentic|automated)\b/.test(text)) return "autonomy";
  if (/\b(why|spike|anomaly|unusual|jump|surge)\b/.test(text)) return "anomaly";
  if (/\b(avg|average|mean|payment size|transaction size)\b/.test(text)) return "average_payment";
  if (/\b(growth|grow|trend|change rate|increas|decreas)\b/.test(text)) return "growth";
  if (
    /\bmpp\b/.test(text) &&
    /\bx402\b|\b402\b/.test(text) &&
    /\b(compare|versus|vs|share|difference|lead|leads|led|leading)\b/.test(text)
  ) return "protocol_comparison";
  if (/\b(payers?|buyers?|senders?|agents?)\b/.test(text)) return "payer_addresses";
  if (/\b(services?|providers?|servers?)\b/.test(text) && /\b(top|most|lead|leads|led|leading|rank|which)\b/.test(text)) return "top_service";
  if (/\b(servers?|recipients?)\b/.test(text)) return "server_identities";
  if (/\b(volume|usd|dollars?|spend|value)\b/.test(text)) return "volume";
  return "transactions";
}

export function asksForChange(question: string) {
  return /\b(chang\w*|trend\w*|grow\w*|increas\w*|decreas\w*|compar\w*|versus|vs)\b/i.test(
    question,
  );
}
