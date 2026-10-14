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
						INGEST_API_TOKEN: "test-ingest-token",
						DASHBOARD_API_TOKEN: "test-dashboard-token",
						ADMIN_API_TOKEN: "test-admin-token",
					},
				},
			};
		}),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
	},
});