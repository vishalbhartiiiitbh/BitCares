import mongoose from 'mongoose';
import { SplitStrategyFactory } from './splitStrategies.js';
import Expense from '../models/Expense.js';
import Balance from '../models/Balance.js';
import Group from '../models/Group.js';
import { eventEmitter, EVENTS } from '../events/eventEmitter.js';

const idString = (id) => id.toString();

export const addExpense = async ({ groupId = null, paidBy, totalAmount, splitStrategy, participants, values, description, currency = 'INR' }) => {
  const session = await mongoose.startSession();
  let createdExpense;
  try {
    await session.withTransaction(async () => {
      if (groupId) {
        const group = await Group.findById(groupId).session(session).select('members');
        if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
        const allowed = new Set(group.members.map(idString));
        if (!allowed.has(idString(paidBy)) || participants.some((id) => !allowed.has(idString(id)))) throw Object.assign(new Error('All users must belong to the group'), { statusCode: 400 });
      }
      const splits = SplitStrategyFactory.get(splitStrategy).calculateSplits(totalAmount, participants, values);
      createdExpense = await Expense.create([{ groupId, description, totalAmount, currency, type: 'EXPENSE', splitStrategy, paidBy, splits }], { session }).then(([expense]) => expense);

      for (const split of splits) {
        if (idString(split.userId) === idString(paidBy)) continue;
        const paidByIsUser1 = idString(paidBy) < idString(split.userId);
        const user1 = paidByIsUser1 ? paidBy : split.userId;
        const user2 = paidByIsUser1 ? split.userId : paidBy;
        const delta = paidByIsUser1 ? split.amountOwed : -split.amountOwed;
        await Balance.findOneAndUpdate(
          { groupId, user1, user2 },
          { $inc: { netOwed: delta }, $set: { updatedAt: new Date() } },
          { upsert: true, new: true, setDefaultsOnInsert: true, session }
        );
      }
    });
    eventEmitter.emit(EVENTS.EXPENSE_CREATED, createdExpense);
    return createdExpense;
  } finally {
    await session.endSession();
  }
};