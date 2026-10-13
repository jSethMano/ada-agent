// Token usage and its estimated cost, read from saved responses. The Worker
// puts the turn's Scout tokens on every body that carries a trace (`usage`,
// src/model-usage.ts), and each Jev row carries its `inputTokens`. Pure, like
// grade.ts: a results file is costed again without sending anything.
// Responses saved before `usage` existed have none, and count as not reported.

import type { CaseRun, StepRun } from './drive.ts';

// Prices as of 2026-10-12. Scout's and its neuron rates are from
// developers.cloudflare.com (Workers AI pricing); the Jev price was supplied
// with them. Re-check before quoting a cost. Neurons are what the free Workers
// AI allocation is counted in, and the quota stop (AiError 4006) is that
// allocation running out.
export const PRICES = {
	asOf: '2026-10-12',
	scout: { inputPerM: 0.27, outputPerM: 0.85, neuronsInputPerM: 24_545, neuronsOutputPerM: 77_273 },
	// Jev's output is free.
	jev: { inputPerM: 0.042 },
	freeNeuronsPerDay: 10_000,
} as const;

/** One step's own tokens: Scout's, from the body's `usage`, and Jev's, from its check rows. */
export type StepUsage = { passes: number; inputTokens: number; outputTokens: number; jevInputTokens: number };

type Percentiles = { p50: number; p95: number };

export type UsageSummary = {
	pricesAsOf: string;
	// Live steps whose response reported usage, out of all live steps.
	live: {
		steps: number;
		of: number;
		inputTokens: Percentiles;
		outputTokens: Percentiles;
		// USD for Scout and Jev together.
		costPerStep: Percentiles & { mean: number };
	};
	// Every step that reported usage, scripted cases with the live model included,
	// since those spend the same allocation.
	run: { steps: number; inputTokens: number; outputTokens: number; jevInputTokens: number; costUsd: number; neurons: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyUsage(step: StepRun): { passes: number; inputTokens: number; outputTokens: number } | null {
	const usage = isRecord(step.body) ? step.body.usage : undefined;
	if (!isRecord(usage)) return null;
	const { passes, inputTokens, outputTokens } = usage;
	return typeof passes === 'number' && typeof inputTokens === 'number' && typeof outputTokens === 'number'
		? { passes, inputTokens, outputTokens }
		: null;
}

function jevTokens(step: StepRun): number {
	const rows = isRecord(step.body) && Array.isArray(step.body.trace) ? step.body.trace.slice(step.prefix) : [];
	return rows.reduce<number>(
		(total, row) => total + (isRecord(row) && row.kind === 'check' && typeof row.inputTokens === 'number' ? row.inputTokens : 0),
		0,
	);
}

/**
 * Each step's own usage, or null when its response reported none. A decision's
 * body carries the whole turn's total, both sides of the pause, the way its
 * trace repeats the paused rows, so the usage of the response it resumed is
 * taken off. A paused response with no usage had nothing to carry.
 */
export function stepUsages(run: CaseRun): Array<StepUsage | null> {
	let paused: { passes: number; inputTokens: number; outputTokens: number } | null = null;
	return run.steps.map((step) => {
		const total = bodyUsage(step);
		const before = 'decision' in step.request ? paused : null;
		if (isRecord(step.body) && isRecord(step.body.approval)) paused = total;
		if (!total) return null;
		return {
			passes: total.passes - (before?.passes ?? 0),
			inputTokens: total.inputTokens - (before?.inputTokens ?? 0),
			outputTokens: total.outputTokens - (before?.outputTokens ?? 0),
			jevInputTokens: jevTokens(step),
		};
	});
}

/** USD for one step's tokens. */
export function costOf(usage: StepUsage): number {
	const perM = (tokens: number, price: number) => (tokens / 1_000_000) * price;
	return (
		perM(usage.inputTokens, PRICES.scout.inputPerM) +
		perM(usage.outputTokens, PRICES.scout.outputPerM) +
		perM(usage.jevInputTokens, PRICES.jev.inputPerM)
	);
}

/**
 * Workers AI neurons for Scout's tokens. The help-article query embeddings
 * also spend neurons, but are not counted: bge-m3's output type has no usage.
 */
export function neuronsOf(usage: { inputTokens: number; outputTokens: number }): number {
	return (
		(usage.inputTokens / 1_000_000) * PRICES.scout.neuronsInputPerM + (usage.outputTokens / 1_000_000) * PRICES.scout.neuronsOutputPerM
	);
}

/** Usage and cost across `runs`. `percentile` is grade.ts's, so latency and tokens are read the same way. */
export function usageSummary(runs: readonly CaseRun[], percentile: (values: number[], p: number) => number): UsageSummary {
	const live: StepUsage[] = [];
	const all: StepUsage[] = [];
	let liveSteps = 0;
	for (const run of runs) {
		const usages = stepUsages(run);
		if (run.harness === 'live') liveSteps += run.steps.length;
		for (const usage of usages) {
			if (!usage) continue;
			all.push(usage);
			if (run.harness === 'live') live.push(usage);
		}
	}
	const spread = (values: number[]) => ({ p50: percentile(values, 50), p95: percentile(values, 95) });
	const costs = live.map(costOf);
	const sum = (pick: (usage: StepUsage) => number) => all.reduce((total, usage) => total + pick(usage), 0);
	const totals = { inputTokens: sum((u) => u.inputTokens), outputTokens: sum((u) => u.outputTokens) };
	return {
		pricesAsOf: PRICES.asOf,
		live: {
			steps: live.length,
			of: liveSteps,
			inputTokens: spread(live.map((u) => u.inputTokens)),
			outputTokens: spread(live.map((u) => u.outputTokens)),
			costPerStep: { ...spread(costs), mean: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0 },
		},
		run: {
			steps: all.length,
			...totals,
			jevInputTokens: sum((u) => u.jevInputTokens),
			costUsd: sum(costOf),
			neurons: neuronsOf(totals),
		},
	};
}
