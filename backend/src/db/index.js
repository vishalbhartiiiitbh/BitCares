import pg from 'pg';

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const query = (text, params) => pool.query(text, params);

export const withTransaction = async (callback) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const connectDB = async () => {
    await query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username VARCHAR(40) NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, fullnamae VARCHAR(120) NOT NULL, phone TEXT, coverimage TEXT, password TEXT NOT NULL, refresh_token TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS groups (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(120) NOT NULL, group_code VARCHAR(8) NOT NULL UNIQUE, created_by UUID NOT NULL REFERENCES users(id), simplify_debts BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS group_members (group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (group_id, user_id));
    CREATE TABLE IF NOT EXISTS expenses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), group_id UUID REFERENCES groups(id), description VARCHAR(500) NOT NULL, total_amount NUMERIC(12,2) NOT NULL, currency VARCHAR(3) NOT NULL DEFAULT 'INR', type VARCHAR(20) NOT NULL DEFAULT 'EXPENSE', split_strategy VARCHAR(20) NOT NULL, paid_by UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS expense_splits (expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id), amount_owed NUMERIC(12,2) NOT NULL, split_value NUMERIC(12,2) NOT NULL, PRIMARY KEY (expense_id, user_id));
    CREATE TABLE IF NOT EXISTS balances (group_id UUID REFERENCES groups(id) ON DELETE CASCADE, user1 UUID NOT NULL REFERENCES users(id), user2 UUID NOT NULL REFERENCES users(id), net_owed NUMERIC(12,2) NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (group_id, user1, user2));
  `);
    console.log('PostgreSQL connected and schema ready');
};

export default connectDB;