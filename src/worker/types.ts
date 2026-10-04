export interface Env {
  RETENTION_DAYS?: string;
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ENV: string;
  LOCAL_AUTH?: string;
  APP_ORIGIN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;
  SESSION_ENCRYPTION_KEY?: string;
}
export type App = {
  Bindings: Env;
  Variables: { owner: string; email: string; requestId: string };
};
