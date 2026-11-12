# Sumi

Sumi is a connected workspace for creator campaigns, group gifts, and office shopping. Creator campaigns are the lead demo: AI helps prepare a campaign and compare fictional creator profiles; people review agreements and authorize PayPal Sandbox payments.

## Try the demo

1. Open the [production workspace](https://sumi.company) and choose **Get started** → **Creator campaigns**.
2. Sign in with Google, then enter the preview access code when prompted. Google OAuth is in Testing mode: your Google account must first be added as a test user.
3. Enter a campaign brief or choose a sample. Review the proposed direction and start the agents. Creator profiles and outreach are fictional; payments are PayPal Sandbox transactions.

Judges: see the private testing instructions in the Devpost submission for the access arrangements. The [release preview](https://sume-candidate-jph-2026.vercel.app) is used for verification.

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

The app uses Google Gemini 2.5 Flash Lite through Vercel AI Gateway for campaign clarification and creator reviews, PayPal Payouts in Sandbox for creator installments, and PayPal Orders and Checkout in Sandbox for gift and office contributions. Bryntum TaskBoard displays campaign progress, and Channel3 provides configured gift product discovery. AI proposes actions; server-side validation and explicit human approval control payments. Sandbox receipts do not represent real commerce.

## Checks

From `backend/`, run `npm test`, `npx tsc --noEmit`, and `npm run build`. The preview and production currently share a database and Sandbox credentials.

## License and assets

The project code is available under the [MIT License](LICENSE). Third-party dependencies, marks, and media have separate terms. See [third-party material](docs/third-party.md) and [stock footage](docs/stock-footage.md).
