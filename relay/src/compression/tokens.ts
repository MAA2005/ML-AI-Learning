/**
 * A cheap, dependency-free token ESTIMATE. Compression runs before the upstream
 * call, so we don't have the provider's real tokenizer — this approximates it
 * (~4 chars/token, a common rule of thumb for English + code). Values are
 * clearly labeled as estimates wherever they surface; the ledger still records
 * the provider's exact counts after the call.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Blend a char-based and whitespace-word-based estimate for a bit more
  // stability across prose vs. code.
  const chars = text.length;
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const byChars = chars / 4;
  const byWords = words * 1.3;
  return Math.max(1, Math.round((byChars + byWords) / 2));
}
