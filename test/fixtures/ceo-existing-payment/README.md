# Existing payment integration baseline

This small synthetic application models an integration after Stripe has settled a
payment. It does not charge a card. The existing ingress adapter verifies the raw
Stripe signature and signing account and supplies the event context. Its userId
metadata remains untrusted. The local user status is a projection of settled
payments; the financial ledger and credentials are unchanged outside this model.

`src/platform.ts` contains the existing transaction boundary and WebhookDispatcher.
The dispatcher only registers and invokes a handler: it supplies no lookup,
notification or order-reading policy. `applyPaidProjection` owns early receipt
deduplication, account/customer checks, account/user-scoped order readers and the
atomic status/receipt/audit commit. A missing order or database exception rolls
back this transaction; ordinary request-error handling stays outside the handler.
It orders the distinct requested line items by ID for the existing mail template.
Notifications run after commit, with no catch, outbox or retry provided by the
facade. A notification failure cannot undo the database commit.

`src/existing-invoice-handler.ts` registers only the current `invoice.paid` path. That
path updates the local projection and audit without sending notification mail.
The proposed PaymentService for `payment_intent.succeeded` is absent. Its proposed
raw user lookup, inline uncaught email, per-order read loop, dispatcher bypass and
missing new-path tests remain the review target in `review-input.md`.

There is no new schema, migration, quarantine service or handler-specific routing
flag to build in this proposal. Deploy and rollback use the application's existing
release procedure. Review actual problems in the proposed handler and baseline;
these fixture assumptions do not preapprove any remedy or exempt a review section.

Run the existing invoice and shared-boundary checks with `bun test contract.test.ts`.
