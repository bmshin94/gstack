import { Database } from 'bun:sqlite';
import { applyPaidProjection, WebhookDispatcher, type User } from './platform';

// The current invoice.paid path updates the local projection and audit only.
// The proposed payment_intent.succeeded PaymentService and email path do not exist.
export function existingDispatcher(db: Database): WebhookDispatcher {
  const dispatcher = new WebhookDispatcher();
  dispatcher.register('invoice.paid', request => applyPaidProjection(db, request, {
    lookupUser: userId => db.query<User, string[]>('SELECT * FROM users WHERE account_id = ? AND id = ?')
      .get(request.accountId, userId) ?? undefined,
    readOrders: (ids, reader) => reader.list(ids),
    afterCommit: async () => {},
  }));
  return dispatcher;
}
