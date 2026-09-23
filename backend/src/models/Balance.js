import mongoose from 'mongoose';

const balanceSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
    user1: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    user2: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    netOwed: { type: mongoose.Schema.Types.Decimal128, required: true, default: '0' },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

balanceSchema.index({ groupId: 1, user1: 1, user2: 1 }, { unique: true });
balanceSchema.index({ user1: 1 });
balanceSchema.index({ user2: 1 });

export default mongoose.model('Balance', balanceSchema);