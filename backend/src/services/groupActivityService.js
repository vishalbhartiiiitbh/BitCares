export const recordGroupActivity = async (client, {
  groupId,
  expenseId = null,
  actorId,
  activityType,
  description,
  details,
  amount = null,
  currency = null,
}) => {
  if (!groupId) return;
  await client.query(
    `INSERT INTO group_activity
       (group_id, expense_id, actor_id, activity_type, description, details, amount, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [groupId, expenseId, actorId, activityType, description, details, amount, currency],
  );
  await client.query(
    `INSERT INTO notifications (user_id, group_id, expense_id, message, created_by, notification_type)
     SELECT user_id, $1, $2, $3, $4, 'GROUP_ACTIVITY' FROM group_members
     WHERE group_id = $1 AND user_id <> $4`,
    [groupId, expenseId, details, actorId],
  );
};
