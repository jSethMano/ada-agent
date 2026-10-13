// Token usage of Llama 4 Scout's passes, summed over a turn. Workers AI
// reports it on each response as `usage: { prompt_tokens, completion_tokens,
// total_tokens }`, optional both in the model's own output type and in the
// OpenAI-style chat completion the router reads (worker-configuration.d.ts).
// Recorded only: nothing the turn does depends on it. Pure, so the sums are
// tested without Workers AI.

/**
 * The turn's model usage so far, across both sides of an approval pause.
 * `passes` counts the passes whose response reported usage, so it equals the
 * body's `iterations` unless Workers AI left usage out of a response.
 */
export type ModelUsage = { passes: number; inputTokens: number; outputTokens: number };

export type PassUsage = { inputTokens: number; outputTokens: number };

function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** One response's token counts, or null when it reports none or only one of the two. Never throws. */
export function usageOf(result: unknown): PassUsage | null {
	const usage = typeof result === 'object' && result !== null ? (result as { usage?: unknown }).usage : undefined;
	if (typeof usage !== 'object' || usage === null) return null;
	const { prompt_tokens: input, completion_tokens: output } = usage as Record<string, unknown>;
	return isCount(input) && isCount(output) ? { inputTokens: input, outputTokens: output } : null;
}

/** `total` with one more pass added. A pass that reported nothing leaves it as it was. */
export function addUsage(total: ModelUsage | undefined, pass: PassUsage | null): ModelUsage | undefined {
	if (!pass) return total;
	return {
		passes: (total?.passes ?? 0) + 1,
		inputTokens: (total?.inputTokens ?? 0) + pass.inputTokens,
		outputTokens: (total?.outputTokens ?? 0) + pass.outputTokens,
	};
}
