# Multi-PSP Payment Routing SDK

This project is a TypeScript payment orchestration SDK and React playground for routing sandbox payments across Stripe, Adyen, Braintree, Square, and Checkout.com.

## Features
- PSP-agnostic SDK with a unified `executeRoute` interface.
- React drag-and-drop playground for merchant routing priority.
- Zod validation for rules, transactions, and metadata.
- Idempotency-key cache and retry middleware.
- World Bank Open Data API used for 2023 payment-system capability metadata.
- Chaos Mesh manifest for fault-injection validation in Kubernetes.

## Data source
The app fetches World Bank indicator `FI.ART.POPS` for the selected country. The 2023 value is used as PSP capability metadata. PSP sandbox calls use public test endpoints and require API credentials from environment variables.

## Setup
Install dependencies:
`npm install`

Set sandbox credentials in your environment before running live executions:
`STRIPE_TEST_KEY=...`
`ADYEN_X_API_KEY=...`
`ADYEN_MERCHANT_ACCOUNT=...`
`BRAINTREE_ACCESS_TOKEN=...`
`SQUARE_SANDBOX_ACCESS_TOKEN=...`
`CHECKOUT_SECRET_KEY=...`
`CHECKOUT_MERCHANT_ID=...`

## Run
`npm run dev`
`npm run test`
`npm run build`

## Chaos Mesh
Deploy `chaos-mesh.yaml` in a namespace where the playground service is labeled `app=payment-routing-sdk`. The manifest injects a 500 ms network delay for high-availability validation.

## Notes
Browser execution is useful for rule preview. Live PSP calls work best in a server-side Node process because sandbox credentials should not be exposed to the browser.