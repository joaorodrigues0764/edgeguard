import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			const migrationsPath = `${import.meta.dirname}/migrations`;
			const migrations =
				await readD1Migrations(migrationsPath);

			return {
				wrangler: {
					configPath: "./wrangler.jsonc",
				},
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
					},
				},
			};
		}),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
	},
});