import mongoose from 'mongoose';

const splitSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amountOwed: { type: mongoose.Schema.Types.Decimal128, required: true },
    splitValue: { type: mongoose.Schema.Types.Decimal128, required: true },
  },
  { _id: false }
);

const expenseSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    totalAmount: { type: mongoose.Schema.Types.Decimal128, required: true },
    currency: { type: String, default: 'INR', uppercase: true, trim: true, maxlength: 3 },
    type: { type: String, enum: ['EXPENSE', 'SETTLEMENT'], default: 'EXPENSE' },
    splitStrategy: { type: String, enum: ['EQUAL', 'EXACT', 'PERCENTAGE'], required: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    splits: { type: [splitSchema], required: true, validate: (value) => value.length > 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

expenseSchema.index({ groupId: 1, createdAt: -1 });
expenseSchema.index({ paidBy: 1, createdAt: -1 });
expenseSchema.index({ 'splits.userId': 1 });

export default mongoose.model('Expense', expenseSchema);