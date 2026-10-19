import pg from "pg";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Supabase pooler connections
  connectionTimeoutMillis: 10000,    // Fail fast instead of hanging forever
});
export const query = (text, params) => pool.query(text, params);

export const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const connectDB = async () => {
  await query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(40) NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      fullnamae VARCHAR(120) NOT NULL,
      phone TEXT,
      coverimage TEXT,
      default_currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      password TEXT NOT NULL,
      refresh_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS default_currency VARCHAR(3) NOT NULL DEFAULT 'INR';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_email_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_email_window_started_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS login_failed_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS login_failure_window_started_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS login_locked_until TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS username_change_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notification_preferences JSONB NOT NULL DEFAULT
      '{"groupAdded":false,"friendAdded":false,"expenseAdded":false,"expenseChanged":false,"expenseComment":false,"expenseDue":false,"paymentReceived":false,"monthlySummary":false,"productUpdates":false}'::jsonb;

    CREATE TABLE IF NOT EXISTS account_email_codes (
      email TEXT NOT NULL,
      purpose VARCHAR(20) NOT NULL,
      code_hash TEXT,
      code_salt TEXT,
      code_expires_at TIMESTAMPTZ,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      send_window_started_at TIMESTAMPTZ,
      verified_token_hash TEXT,
      verified_expires_at TIMESTAMPTZ,
      PRIMARY KEY (email, purpose)
    );
    ALTER TABLE account_email_codes DROP CONSTRAINT IF EXISTS account_email_codes_purpose_check;
    ALTER TABLE account_email_codes
      ADD CONSTRAINT account_email_codes_purpose_check
      CHECK (purpose IN ('signup', 'delete_account', 'email_change_old', 'email_change_new'));
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email));
    CREATE TABLE IF NOT EXISTS email_notification_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS email_notification_outbox_pending_idx
      ON email_notification_outbox (next_attempt_at, created_at)
      WHERE sent_at IS NULL;
    CREATE TABLE IF NOT EXISTS email_notification_monthly_summary (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month_start DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, month_start)
    );

    CREATE TABLE IF NOT EXISTS friendships (
      user_low UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_high UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_low, user_high),
      CHECK (user_low < user_high)
    );
    CREATE TABLE IF NOT EXISTS friend_invite_codes (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code VARCHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS referral_codes (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code VARCHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS referrals (
      referred_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      referrer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points_awarded INTEGER NOT NULL DEFAULT 10 CHECK (points_awarded = 10),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (referred_user_id <> referrer_user_id)
    );
    CREATE INDEX IF NOT EXISTS referrals_referrer_idx
      ON referrals (referrer_user_id, created_at);
    CREATE TABLE IF NOT EXISTS referral_points (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_user_id UUID NOT NULL,
      points_awarded INTEGER NOT NULL DEFAULT 10 CHECK (points_awarded = 10),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, referred_user_id)
    );
    CREATE INDEX IF NOT EXISTS referral_points_user_idx
      ON referral_points (user_id, created_at);

    CREATE TABLE IF NOT EXISTS friend_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(12) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (sender_id <> receiver_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_one_pending_per_pair
      ON friend_requests (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id))
      WHERE status = 'pending';

      
    CREATE TABLE IF NOT EXISTS groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(120) NOT NULL,
      group_code VARCHAR(8) NOT NULL UNIQUE,
      created_by UUID NOT NULL REFERENCES users(id),
      simplify_debts BOOLEAN NOT NULL DEFAULT FALSE,
      is_personal BOOLEAN NOT NULL DEFAULT FALSE,
      is_friend_ledger BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE groups
      ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE groups
      ADD COLUMN IF NOT EXISTS is_friend_ledger BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
    ALTER TABLE groups
      ADD COLUMN IF NOT EXISTS simplify_debts BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE groups ALTER COLUMN simplify_debts SET DEFAULT FALSE;

    CREATE UNIQUE INDEX IF NOT EXISTS groups_one_personal_per_user
      ON groups (created_by)
      WHERE is_personal = TRUE;

    CREATE TABLE IF NOT EXISTS group_members (
      group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS friend_ledgers (
      user_low UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_high UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id UUID NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_low, user_high),
      CHECK (user_low < user_high)
    );

    ALTER TABLE group_members
      DROP CONSTRAINT IF EXISTS group_members_group_id_fkey;
    ALTER TABLE group_members
      ADD CONSTRAINT group_members_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;

    CREATE TABLE IF NOT EXISTS expenses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
      description VARCHAR(500) NOT NULL,
      total_amount NUMERIC(12, 2) NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      type VARCHAR(20) NOT NULL DEFAULT 'EXPENSE',
      split_strategy VARCHAR(20) NOT NULL,
      paid_by UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE expenses
      DROP CONSTRAINT IF EXISTS expenses_group_id_fkey;
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
    ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS category VARCHAR(40) NOT NULL DEFAULT 'Uncategorized';
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS subcategory VARCHAR(60);
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_proof_url TEXT;
    CREATE TABLE IF NOT EXISTS expense_splits (expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id), amount_owed NUMERIC(12,2) NOT NULL, split_value NUMERIC(12,2) NOT NULL, PRIMARY KEY (expense_id, user_id));
    CREATE TABLE IF NOT EXISTS expense_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, description VARCHAR(500) NOT NULL, amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS expense_item_splits (item_id UUID NOT NULL REFERENCES expense_items(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id), amount_owed NUMERIC(12,2) NOT NULL, PRIMARY KEY (item_id, user_id));
    CREATE TABLE IF NOT EXISTS expense_comments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, content VARCHAR(1000) NOT NULL CHECK (length(trim(content)) > 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS notifications (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id UUID REFERENCES groups(id) ON DELETE CASCADE, expense_id UUID REFERENCES expenses(id) ON DELETE CASCADE, message TEXT NOT NULL, created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), read_at TIMESTAMPTZ);
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS notification_type VARCHAR(30) NOT NULL DEFAULT 'GROUP_ACTIVITY';
    CREATE TABLE IF NOT EXISTS group_activity (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE, expense_id UUID REFERENCES expenses(id) ON DELETE SET NULL, actor_id UUID NOT NULL REFERENCES users(id), activity_type VARCHAR(40) NOT NULL, description TEXT NOT NULL, details TEXT NOT NULL, amount NUMERIC(12,2), currency VARCHAR(3), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS group_activity_group_created_idx ON group_activity (group_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS group_whiteboards (
      group_id UUID PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      updated_by UUID NOT NULL REFERENCES users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (length(content) <= 5000)
    );
    CREATE TABLE IF NOT EXISTS balances (group_id UUID REFERENCES groups(id) ON DELETE CASCADE, user1 UUID NOT NULL REFERENCES users(id), user2 UUID NOT NULL REFERENCES users(id), currency VARCHAR(3) NOT NULL DEFAULT 'INR', net_owed NUMERIC(12,2) NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (group_id, user1, user2, currency));
    ALTER TABLE balances ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'INR';
    ALTER TABLE balances DROP CONSTRAINT IF EXISTS balances_pkey;
    ALTER TABLE balances
      ADD CONSTRAINT balances_pkey PRIMARY KEY (group_id, user1, user2, currency);
    ALTER TABLE balances
      DROP CONSTRAINT IF EXISTS balances_group_id_fkey;
    ALTER TABLE balances
      ADD CONSTRAINT balances_group_id_fkey
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;

    CREATE TABLE IF NOT EXISTS group_settlements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      paid_by UUID NOT NULL REFERENCES users(id),
      paid_to UUID NOT NULL REFERENCES users(id),
      amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
      currency VARCHAR(3) NOT NULL,
      note TEXT,
      payment_proof_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (paid_by <> paid_to)
    );
    CREATE TABLE IF NOT EXISTS friend_settlements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      paid_by UUID NOT NULL REFERENCES users(id),
      paid_to UUID NOT NULL REFERENCES users(id),
      amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
      currency VARCHAR(3) NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (paid_by <> paid_to)
    );
    CREATE TABLE IF NOT EXISTS friend_settlement_allocations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      settlement_id UUID NOT NULL REFERENCES friend_settlements(id) ON DELETE CASCADE,
      group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
      currency VARCHAR(3) NOT NULL,
      exchange_rate NUMERIC(18, 8) NOT NULL CHECK (exchange_rate > 0)
    );
    UPDATE notifications
       SET notification_type = 'PAYMENT_REQUEST'
     WHERE notification_type = 'GROUP_ACTIVITY'
       AND message LIKE '% requested % from %';
    UPDATE notifications n
       SET notification_type = 'PAYMENT_RECEIVED'
     WHERE n.notification_type = 'GROUP_ACTIVITY'
       AND EXISTS (
         SELECT 1
           FROM group_settlements s
           JOIN users payer ON payer.id = s.paid_by
           JOIN users payee ON payee.id = s.paid_to
          WHERE s.group_id = n.group_id
            AND s.paid_by = n.created_by
            AND s.paid_to = n.user_id
            AND abs(extract(epoch FROM (s.created_at - n.created_at))) < 10
            AND n.message = payer.fullnamae || ' paid ' || payee.fullnamae || ' ' || s.currency || ' ' || to_char(s.amount, 'FM999999999990.00') || '.'
       );
  `);
  console.log("PostgreSQL connected and schema ready");
};

export default connectDB;
