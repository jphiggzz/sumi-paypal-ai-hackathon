# Sumi

Sumi is a connected workspace for creator campaigns, group gifts, and office shopping. Creator campaigns are the lead demo: AI helps prepare a campaign and compare fictional creator profiles; people review agreements and authorize PayPal Sandbox payments.

## Try the demo

The [production workspace](https://sumi.company) uses Google sign-in and a preview access code shared separately. Google OAuth is in testing, so a judge account may need to be added as a test user. The [release preview](https://sume-candidate-jph-2026.vercel.app) is used for verification.

## Run locally

Use Node 22 and a PostgreSQL database. From `backend/`:

```sh
npm ci
cp .env.example .env.local
# Configure the required services and register the local Google OAuth callback.
npm run db:migrate
npm run dev -- --port 3000
```

Open http://localhost:3000. See `backend/.env.example` for configuration names. Never commit credentials or personal payment data.

## Boundaries

- Creator profiles, outreach, responses, and delivery are simulated; eligible approved payments use PayPal Sandbox.
- Group gifts use participant-controlled context sharing and individual Sandbox contributions. Retailer purchasing is a separate handoff.
- Office shopping uses reviewed baskets and labeled simulated supplier activity; external retailer fulfillment is not connected.

AI proposes actions; server-side validation and explicit human approval control payments. Sandbox receipts do not represent real commerce.

## Checks

From `backend/`, run `npm test`, `npx tsc --noEmit`, and `npm run build`. The preview and production currently share a database and Sandbox credentials.

## License and assets

The project code is available under the [MIT License](LICENSE). Third-party dependencies, marks, and media have separate terms. See [third-party material](docs/third-party.md) and [stock footage](docs/stock-footage.md).
