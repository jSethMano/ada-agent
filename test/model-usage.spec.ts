import { describe, expect, it } from 'vitest';
import { addUsage, usageOf } from '../src/model-usage';

describe('usageOf', () => {
	it('reads the prompt and completion tokens Workers AI reports', () => {
		expect(usageOf({ usage: { prompt_tokens: 1843, completion_tokens: 27, total_tokens: 1870 } })).toEqual({
			inputTokens: 1843,
			outputTokens: 27,
		});
		expect(usageOf({ usage: { prompt_tokens: 0, completion_tokens: 0 } })).toEqual({ inputTokens: 0, outputTokens: 0 });
	});

	it('reads nothing from a response without both counts', () => {
		for (const usage of [undefined, null, 'lots', {}, { prompt_tokens: 10 }, { completion_tokens: 3 }, { prompt_tokens: -1, completion_tokens: 3 }]) {
			expect(usageOf({ usage }), JSON.stringify(usage)).toBeNull();
		}
		expect(usageOf({ usage: { prompt_tokens: '10', completion_tokens: 3 } })).toBeNull();
		expect(usageOf({ usage: { prompt_tokens: Number.NaN, completion_tokens: 3 } })).toBeNull();
		// Never throws, so a strange response fails the turn where it did before, not here.
		for (const result of [undefined, null, 'text']) expect(usageOf(result)).toBeNull();
	});
});

describe('addUsage', () => {
	it('starts a total at the first pass that reports, and adds each one after', () => {
		const first = addUsage(undefined, { inputTokens: 1000, outputTokens: 20 });
		expect(first).toEqual({ passes: 1, inputTokens: 1000, outputTokens: 20 });
		expect(addUsage(first, { inputTokens: 1100, outputTokens: 30 })).toEqual({ passes: 2, inputTokens: 2100, outputTokens: 50 });
	});

	it('leaves the total as it was for a pass that reported nothing', () => {
		expect(addUsage(undefined, null)).toBeUndefined();
		const total = { passes: 2, inputTokens: 2100, outputTokens: 50 };
		expect(addUsage(total, null)).toBe(total);
	});
});
