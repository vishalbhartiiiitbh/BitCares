import { eventEmitter, EVENTS } from '../events/eventEmitter.js';

/** Persist and distribute a notification in response to a registered app event. */
const notify = async (event, payload) => {
  await new Promise((resolve) => setImmediate(resolve));
  console.info(`[notification] ${event}`, { expenseId: payload._id?.toString?.() });
};
eventEmitter.on(EVENTS.EXPENSE_CREATED, (expense) => void notify(EVENTS.EXPENSE_CREATED, expense));
eventEmitter.on(EVENTS.EXPENSE_UPDATED, (expense) => void notify(EVENTS.EXPENSE_UPDATED, expense));
eventEmitter.on(EVENTS.PAYMENT_SETTLED, (payment) => void notify(EVENTS.PAYMENT_SETTLED, payment));