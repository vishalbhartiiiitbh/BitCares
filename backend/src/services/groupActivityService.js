import { queueEmailNotification } from './emailNotificationService.js';

const emailPreferencesByActivity = {
  GROUP_CREATED: 'groupAdded',
  MEMBER_ADDED: 'groupAdded',
  MEMBER_JOINED: 'groupAdded',
  WHITEBOARD_UPDATED: 'whiteboardUpdated',
  EXPENSE_ADDED: 'expenseAdded',
  EXPENSE_UPDATED: 'expenseChanged',
  EXPENSE_DELETED: 'expenseChanged',
  COMMENT_ADDED: 'expenseComment',
  COMMENT_DELETED: 'expenseComment',
};

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
  // Reuse the caller's transaction so the activity, in-app alerts, and queued emails stay in sync.
  await client.query(
    `INSERT INTO group_activity
       (group_id, expense_id, actor_id, activity_type, description, details, amount, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [groupId, expenseId, actorId, activityType, description, details, amount, currency],
  );
  const recipients = await client.query(
    `INSERT INTO notifications (user_id, group_id, expense_id, message, created_by, notification_type)
     SELECT user_id, $1, $2, $3, $4, 'GROUP_ACTIVITY' FROM group_members
     WHERE group_id = $1 AND user_id <> $4
     RETURNING user_id`,
    [groupId, expenseId, details, actorId],
  );
  const preference = emailPreferencesByActivity[activityType];
  if (preference) {
    const subject = activityType.startsWith('EXPENSE_') ? 'Splitpayerly expense update' : 'Splitpayerly group update';
    for (const recipient of recipients.rows) {
      await queueEmailNotification(client, recipient.user_id, preference, subject, details);
    }
  }
};
