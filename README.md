# Sumi

Sumi is a connected workspace for creator campaigns, group gifts, and office shopping. Creator campaigns are the lead demo: AI helps prepare a campaign and compare fictional creator profiles; people review agreements and authorize PayPal Sandbox payments.

## Try the demo

1. Judges: open [judge access](https://sumi.company/workspace?judge=1) and enter the code in the private Devpost testing instructions. No Google account is required.
2. Enter a campaign brief or choose a sample. Review the proposed direction and start the agents. Creator profiles and outreach are fictional; payments are PayPal Sandbox transactions.

Other preview users can continue to use Google sign-in and the existing preview access code. Google OAuth is in Testing mode, so those accounts must be added as test users.

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
