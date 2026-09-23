import mongoose from 'mongoose';
import Group from '../models/Group.js';
import User from '../models/User.js';
import Balance from '../models/Balance.js';

export const leaveGroup = async (groupId, userId) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const unsettled = await Balance.exists({ groupId, $or: [{ user1: userId }, { user2: userId }], netOwed: { $ne: mongoose.Types.Decimal128.fromString('0') } }).session(session);
      if (unsettled) throw Object.assign(new Error('Cannot leave group with unsettled balances'), { statusCode: 400 });
      const group = await Group.findOneAndUpdate({ _id: groupId, members: userId }, { $pull: { members: userId } }, { new: true, session });
      if (!group) throw Object.assign(new Error('Group or membership not found'), { statusCode: 404 });
      await User.updateOne({ _id: userId }, { $pull: { groups: groupId } }, { session });
      result = group;
    });
    return result;
  } finally {
    await session.endSession();
  }
};