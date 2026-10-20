import { query, withTransaction } from '../db/index.js';
import { sendNotificationEmail } from './emailService.js';

export const EMAIL_NOTIFICATION_PREFERENCES = Object.freeze({
  groupAdded: false,
  whiteboardUpdated: false,
  friendAdded: false,
  expenseAdded: false,
  expenseChanged: false,
  expenseComment: false,
  expenseDue: false,
  paymentReceived: false,
  monthlySummary: false,
  productUpdates: false,
});

export const queueEmailNotification = async (client, userId, preference, subject, body) => {
  if (!Object.hasOwn(EMAIL_NOTIFICATION_PREFERENCES, preference)) {
    throw new Error(`Unknown email notification preference: ${preference}`);
  }
  await client.query(
    `INSERT INTO email_notification_outbox (user_id, recipient_email, subject, body)
     SELECT id, email, $3, $4
       FROM users
      WHERE id = $1
        AND COALESCE((email_notification_preferences ->> $2)::boolean, false)`,
    [userId, preference, subject, body],
  );
};

let workerRunning = false;

const deliverBatch = async () => {
  if (workerRunning) return;
  workerRunning = true;
  try {
    // SKIP LOCKED lets separate app instances claim different pending messages safely.
    const { rows } = await query(
      `UPDATE email_notification_outbox
          SET locked_at = NOW(), attempts = attempts + 1
        WHERE id IN (
          SELECT id
            FROM email_notification_outbox
           WHERE sent_at IS NULL
             AND attempts < 5
             AND next_attempt_at <= NOW()
             AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '5 minutes')
           ORDER BY created_at
           LIMIT 10
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, recipient_email, subject, body, attempts`,
    );

    for (const item of rows) {
      try {
        await sendNotificationEmail(item.recipient_email, item.subject, item.body);
        await query(
          'UPDATE email_notification_outbox SET sent_at = NOW(), locked_at = NULL WHERE id = $1',
          [item.id],
        );
      } catch (error) {
        console.error('Email notification delivery failed:', {
          outboxId: item.id,
          attempt: item.attempts,
          message: error.message,
        });
        await query(
          // Exponential delay caps retries at one hour; attempts are bounded in the claim query.
          `UPDATE email_notification_outbox
              SET locked_at = NULL,
                  next_attempt_at = NOW() + ($2 * INTERVAL '1 minute')
            WHERE id = $1`,
          [item.id, Math.min(2 ** item.attempts, 60)],
        );
      }
    }
  } catch (error) {
    console.error('Email notification worker failed:', error.message);
  } finally {
    workerRunning = false;
  }
};

const queueMonthlySummaries = async () => {
  const period = await query(
    `SELECT date_trunc('month', NOW())::date - INTERVAL '1 month' AS "monthStart",
            date_trunc('month', NOW())::date AS "currentMonth",
            EXTRACT(DAY FROM NOW()) AS day,
            EXTRACT(HOUR FROM NOW()) AS hour`,
  );
  const schedule = period.rows[0];
  if (Number(schedule.day) !== 1 || Number(schedule.hour) < 9) return;

  const recipients = await query(
    `SELECT id AS "userId" FROM users
      WHERE COALESCE((email_notification_preferences ->> 'monthlySummary')::boolean, false)`,
  );

  for (const recipient of recipients.rows) {
    await withTransaction(async (client) => {
      const delivery = await client.query(
        // The unique user/month key makes this scheduled job safe to run more than once.
        `INSERT INTO email_notification_monthly_summary (user_id, month_start)
         SELECT id, $2::date
           FROM users
          WHERE id = $1
            AND COALESCE((email_notification_preferences ->> 'monthlySummary')::boolean, false)
         ON CONFLICT DO NOTHING
         RETURNING user_id`,
        [recipient.userId, schedule.monthStart],
      );
      if (!delivery.rowCount) return;

      const summary = await client.query(
        `SELECT COUNT(DISTINCT e.id)::integer AS "expenseCount",
                COALESCE(SUM(e.total_amount) FILTER (WHERE e.paid_by = $1), 0)::text AS "paidTotal"
           FROM expenses e
          WHERE e.created_at >= $2::date
            AND e.created_at < $3::date
            AND (e.paid_by = $1 OR EXISTS (
              SELECT 1 FROM expense_splits s WHERE s.expense_id = e.id AND s.user_id = $1
            ))`,
        [recipient.userId, schedule.monthStart, schedule.currentMonth],
      );
      const { expenseCount, paidTotal } = summary.rows[0];
      const user = await client.query('SELECT email FROM users WHERE id = $1', [recipient.userId]);
      if (!user.rowCount) return;
      const monthName = new Date(schedule.monthStart).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      await client.query(
        `INSERT INTO email_notification_outbox (user_id, recipient_email, subject, body)
         VALUES ($1, $2, $3, $4)`,
        [
          recipient.userId,
          user.rows[0].email,
          `Your SplitCare activity summary for ${monthName}`,
          `Your SplitCare activity for ${monthName}:\n\nExpenses you participated in: ${expenseCount}\nTotal you paid: ${paidTotal}\n\nOpen SplitCare to review your groups, expenses, and balances.`,
        ],
      );
    });
  }
};

let monthlySummaryRunning = false;
const runMonthlySummary = async () => {
  if (monthlySummaryRunning) return;
  monthlySummaryRunning = true;
  try {
    await queueMonthlySummaries();
  } catch (error) {
    console.error('Monthly email summary job failed:', error.message);
  } finally {
    monthlySummaryRunning = false;
  }
};

export const startEmailNotificationWorker = () => {
  const interval = setInterval(() => void deliverBatch(), 5000);
  const summaryInterval = setInterval(() => void runMonthlySummary(), 60 * 60 * 1000);
  interval.unref();
  summaryInterval.unref();
  void deliverBatch();
  void runMonthlySummary();
};
