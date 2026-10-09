import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// `npm run eval` swaps the unit tests for the live Jev cases. Those call
// TypeSafe with the key from .env, so they are opt-in rather than part of
// `npm test`.
const evals = process.env.JEV_EVAL === "1";
// `npm run eval:agent` runs the scripted end-to-end cases here, where a test
// can fake Workers AI and ItAgent for one Chak instance. See evals/run.ts.
const scripted = process.env.SCRIPTED_EVAL === "1";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
	test: {
		include: evals ? ["test/**/*.eval.ts"] : scripted ? ["test/**/*.harness.ts"] : ["test/**/*.spec.ts"],
		testTimeout: evals ? 30_000 : scripted ? 90_000 : 5_000,
	},
});
