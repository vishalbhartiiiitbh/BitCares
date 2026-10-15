import { EventEmitter } from 'node:events';

export const EVENTS = Object.freeze({ EXPENSE_CREATED: 'EXPENSE_CREATED', EXPENSE_UPDATED: 'EXPENSE_UPDATED', PAYMENT_SETTLED: 'PAYMENT_SETTLED' });
export const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(100);