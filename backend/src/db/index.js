import pg from "pg";

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
      password TEXT NOT NULL,
      refresh_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS friendships (
      user_low UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_high UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_low, user_high),
      CHECK (user_low < user_high)
    );

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE groups
      ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT FALSE;
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
  `);
  console.log("PostgreSQL connected and schema ready");
};

export default connectDB;
