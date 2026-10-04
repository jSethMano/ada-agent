import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// `npm run eval` swaps the unit tests for the live Jev cases. Those call
// TypeSafe with the key from .env, so they are opt-in rather than part of
// `npm test`.
const evals = process.env.JEV_EVAL === "1";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
	test: {
		include: evals ? ["test/**/*.eval.ts"] : ["test/**/*.spec.ts"],
		testTimeout: evals ? 30_000 : 5_000,
	},
});
