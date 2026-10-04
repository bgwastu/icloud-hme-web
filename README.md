<img src="public/logo.svg" alt="App logo" width="96" height="96">

# iCloud Hide My Email

A self-hosted app for managing iCloud+ Hide My Email addresses, built with Mantine, Cloudflare Workers, and D1.

AI Disclosure: Human Validated.

- Create addresses and edit their labels and notes.
- Deactivate, reactivate, or delete addresses.
- Search, copy, and export addresses, with automatic sync.

Cloudflare Access protects the app. The setup wizard connects one Apple account and stores its session encrypted. Apple may require you to reconnect when the session expires.

## Development

Requires Node 24.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Set SESSION_ENCRYPTION_KEY using: openssl rand -base64 32
npm run build
npm run db:local
npm run dev
```

Run `npm run check` for application and asset checks. Run `npx playwright install chromium` and `npm run test:e2e` for browser checks.

## Deployment

Create a D1 database and a Cloudflare Access application for your domain. Use the same allowed email addresses in Access and `ALLOWED_EMAILS`.

Add these GitHub secrets to the `production` environment: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_EMAILS`, and `APP_ORIGIN`.

For the first deployment, set these values locally plus `WORKER_NAME=icloud-hme-web` and a random `SESSION_ENCRYPTION_KEY`, then run `npm run deploy`. Keep the encryption key safe and reuse it. Subsequent passing pushes to `main` deploy through GitHub Actions and preserve the key.

Licensed under [MIT](LICENSE). The envelope icon comes from [Tabler Icons](https://tabler.io/icons); its [MIT notice](public/tabler-icons-LICENSE.txt) is included.
