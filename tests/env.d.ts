import type { Env as AppEnv } from "../src/worker/types";
import type { D1Migration } from "@cloudflare/vitest-plugin";
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
export {};
