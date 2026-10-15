# SplitCare

SplitCare is an expense-sharing application with a Node.js, Express, and PostgreSQL backend.

## Backend Setup

```bash
cd backend
npm install
cp .env.example .env
```

Update `backend/.env` with your PostgreSQL `DATABASE_URL` and private JWT, Cloudinary, and other credentials. Do not commit `.env`.

Start the development server:

```bash
npm run dev
```

The API runs at `http://localhost:5000` by default.

Health check:

```bash
curl http://localhost:5000/api/health
```

## Authentication API

Register a user:

```bash
curl -X POST http://localhost:5000/api/users/register \
	-H 'Content-Type: application/json' \
	-d '{
		"username": "john",
		"email": "john@example.com",
		"fullnamae": "John Doe",
		"password": "password123"
	}'
```

Login with email or username:

```bash
curl -X POST http://localhost:5000/api/users/login \
	-H 'Content-Type: application/json' \
	-d '{
		"email": "john@example.com",
		"password": "password123"
	}'
```

Refresh an access token:

```bash
curl -X POST http://localhost:5000/api/users/refresh-token \
	-H 'Content-Type: application/json' \
	-d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'
```

The API also sets HTTP-only `accessToken` and `refreshToken` cookies on registration and login. Refresh tokens are stored in MongoDB but excluded from normal user queries.

## Frontend Setup

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

The frontend runs at `http://localhost:5173` and uses `VITE_API_URL` from `frontend/.env` to reach the backend.

The connected dashboard uses these authenticated endpoints:

- `GET /api/users/me`
- `GET /api/groups`
- `POST /api/groups` accepts multipart fields `name`, optional JSON-array strings `memberIds` and `memberIdentifiers`, optional `simplifyDebts` (defaults to `false`), and optional `coverImage` image (up to 5 MB).
- `POST /api/groups` can include `memberIds` (friend user IDs) and/or `memberIdentifiers` (usernames or registered email addresses); the creator is added automatically.
- `POST /api/groups/join` with `{ "groupCode": "A1B2C3D4" }`
- `POST /api/groups/:groupId/members` with `{ "identifier": "username or registered email" }` (any current group member can add an account directly).
- `GET /api/groups/:groupId/balances` returns only the authenticated member's balances, with amounts owed to or by that member.
- `POST /api/groups/:groupId/settlements` accepts `multipart/form-data` with `payeeId`, `amount`, `currency`, optional `note`, and optional `paymentProof` image (up to 5 MB). The authenticated member is the payer. Payments are recorded in group activity and reduce their outstanding debt; in groups with debt simplification enabled, payments can follow the latest simplified plan.
- `PATCH /api/groups/:groupId` (any group member; accepts multipart fields `name`, `simplifyDebts` and optional `coverImage` image or `removeCoverImage=true`)
- `DELETE /api/groups/:groupId/members/:memberId` removes another member when their group balances are settled; any current member can request it, but the creator and requester cannot be removed through this endpoint.
- `DELETE /api/groups/:groupId` (group creator only; deletes the group and its expenses after all balances are settled)
- `POST /api/groups/:groupId/leave` (leaving requires the entire group to be settled; leaving as the last member deletes the group and its related data)
- `GET /api/expenses`
- `GET /api/expenses/personal` returns all of the signed-in user's personal expenses, organized month by month in the dashboard.
- `POST /api/expenses` accepts `multipart/form-data` with `description`, `totalAmount`, `currency`, `category`, optional `subcategory`, `groupId`, `paidBy`, `participants` (JSON array), `splitStrategy` (`EQUAL`, `EXACT`, `PERCENTAGE`, `SHARES`, `ADJUSTMENT`, `REIMBURSEMENT`, or `ITEMIZED`), `values` (JSON array when required), optional `items` (JSON array for itemized expenses), optional `paymentProof` image (up to 5 MB), and optional `note`. If `groupId` is omitted, the expense is stored in the account's private, single-member `Personal Expenses` group. Categories are Entertainment, Food and drink, Home, Life, Transportation, Uncategorized, and Utilities. Payment proof uploads use the configured Cloudinary account.
- `PATCH /api/expenses/:expenseId` accepts the same expense fields to update an existing entry. Any member of the expense's group can edit it; group balances and split/item details are recalculated, and all group members receive an in-app notification.
- `GET /api/expenses?groupId=<groupId>` includes comments on each expense. `POST /api/expenses/:expenseId/comments` accepts `{ "content": "Comment text" }` from any group member; `DELETE /api/expenses/comments/:commentId` lets the comment author remove their comment.
- `GET /api/users/notifications` lists recent in-app notifications for the signed-in user; `PATCH /api/users/notifications/read` marks them as read.
- `POST /api/groups/:groupId/leave`
- `GET /api/groups/:groupId/simplify-debts` recalculates suggested transfers from all current expenses and recorded payments. The group preference controls whether it combines member balances; suggestions do not change balances until a payment is recorded.
