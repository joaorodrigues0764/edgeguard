import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
	interface Env {
		TEST_MIGRATIONS: D1Migration[];
	}
}

declare module "cloudflare:workers" {
	interface ProvidedEnv {
		TEST_MIGRATIONS: D1Migration[];
	}
}