# SplitCare

SplitCare is an expense-sharing application with a Node.js, Express, and PostgreSQL backend.

## Backend Setup

```bash
cd backend
npm install
cp .env.example .env
```

Update `backend/.env` with your PostgreSQL `DATABASE_URL` and private JWT, Cloudinary, and other credentials. Do not commit `.env`.

Currency conversion uses ExchangeRate-API. Set `EXCHANGE_RATE_API_KEY` in
`backend/.env` (and in the backend host's environment settings) to your private
API key. The group creator chooses one base currency when creating a group and
can change it later from that group's Settings tab. Changing it converts the
group's existing financial history using current provider rates.
Members can enter expenses in other supported currencies; amounts, splits, and
balances are converted into the group currency before they are saved. Expense
history retains the entered amount, currency, and conversion rate. Existing
groups' legacy balances and expenses are normalized on first access using the
provider's current rate. Dashboard summaries can be viewed in each member's
profile default currency; the group's ledger remains in its shared base currency.

Password reset email uses Nodemailer and SMTP. Configure `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_USER`, and `SMTP_PASS` in `backend/.env`. For Gmail, use
an app password (with 2-Step Verification enabled), not your regular Gmail
password. Set `EMAIL_FROM` to the sender address and `FRONTEND_URL` to the
frontend origin used in reset links. Reset links expire after 10 minutes and
are invalidated after a successful password change.

The recovery endpoints are `POST /api/users/forgot-password` with
`{"email":"person@example.com"}` and `POST /api/users/reset-password` with
`{"token":"token-from-email","password":"new-password"}`. Reset requests
return a generic message whether or not the email belongs to an account.
For each account, password reset emails are limited to five per 10-minute
window. Five incorrect passwords within a 5-minute window temporarily lock
login for 30 minutes. Completing a password reset clears the lock immediately;
otherwise, the user can sign in after the lock expires.

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

First request a 6-digit code, then verify it. Verification codes expire after
10 minutes, allow at most five attempts, and are limited to five emails per
10-minute window:

```bash
curl -X POST http://localhost:5000/api/users/register/send-code \
	-H 'Content-Type: application/json' \
	-d '{"email":"john@example.com"}'

curl -X POST http://localhost:5000/api/users/register/verify-code \
	-H 'Content-Type: application/json' \
	-d '{"email":"john@example.com","code":"123456"}'
```

Use the `verificationToken` returned by the verification request to create the
account:

```bash
curl -X POST http://localhost:5000/api/users/register \
	-H 'Content-Type: application/json' \
	-d '{
		"username": "john",
		"email": "john@example.com",
		"fullnamae": "John Doe",
		"password": "password123",
		"verificationToken": "TOKEN_FROM_EMAIL_VERIFICATION"
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

The API also sets HTTP-only `accessToken` and `refreshToken` cookies on registration and login. Refresh tokens are stored in PostgreSQL and excluded from normal user queries.

From the profile, users can request a one-time email code and confirm permanent
account deletion. The deletion removes groups created by the account, friend
ledgers involving it, and shared expenses in which the user participated, as
well as other records that reference the account. `POST /api/users/profile/delete-account/send-code`
sends the code; authenticated
`DELETE /api/users/profile/account` accepts `{"code":"123456"}`.

To change the account email in the profile, request codes with authenticated
`POST /api/users/profile/email-change/send-codes` using
`{"newEmail":"new-address@example.com"}`. The user must then submit both codes
to authenticated `POST /api/users/profile/email-change/verify` with
`{"newEmail":"new-address@example.com","oldCode":"123456","newCode":"654321"}`.
Both codes expire after 10 minutes, and the new email cannot already be linked
to an account. After a successful change, a confirmation email is queued to the
new address with both the previous and updated email addresses.

Users can share a persistent friend QR code or link from the Friends section or
the profile menu. The code remains the same until the owner explicitly changes
it; changing it invalidates all previously shared QR codes and links. Anyone
using the link must sign in or register before the friendship is created.
Authenticated `GET /api/friends/invite-code` retrieves or creates the user's
code, `POST /api/friends/invite-code/change` changes it, and
`POST /api/friends/invite-code/accept` accepts a code with
`{"code":"FRIEND_CODE"}`. Camera scanning requires browser camera permission
and a secure context (HTTPS, or localhost).

The Friends section also provides a referral link containing the referrer's
username and referral code. When a new user signs up through that link and
verifies their email, both the referrer and new user receive 10 points and are
connected as friends. Each account can receive the signup referral reward only
once. Points are tracked for future membership rewards; membership redemption
is not available yet.

Users can change their username at most twice over the lifetime of the account.
The limit is enforced by the backend and shown in the profile. Username and
email updates modify the existing user record; related groups, expenses, and
balances remain attached by the user's stable ID.

## Email Notifications

Users can expand **Email notification settings** in their profile to enable or
disable emails for group membership, friend requests, expense activity and
comments, payment requests, payments received, and monthly activity summaries.
All email categories are off by default. Settings are available through the
authenticated `GET` and `PUT /api/users/profile/email-notifications` endpoints;
the `PUT` body contains a boolean for every preference under `preferences`.

Notifications are queued in PostgreSQL and delivered by the backend worker
using the SMTP settings above. Delivery is attempted up to five times.
Monthly summaries are queued on the first day of each month after 09:00 server
time. Payment request email is sent when a member explicitly requests payment;
the app does not currently schedule automatic due-date reminders. The
product-update preference is saved, but the app does not currently publish
product announcements.

## Frontend Setup

The frontend toolchain requires Node.js `^20.19.0` or `>=22.12.0`.

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
- In a group's Settings, **Export data as CSV** exports the group's transaction history using Splitwise's `Date, Description, Category, Cost, Currency, <members...>` layout. **Import Splitwise history** previews a `.csv` export and asks you to map each Splitwise member column to a distinct existing group member before applying it.
- `POST /api/groups/:groupId/splitwise-import/preview` accepts multipart field `file` (CSV up to 5 MB) and validates the Splitwise export without changing the group. `POST /api/groups/:groupId/splitwise-import` accepts the same file plus JSON `memberMappings` (an object from each CSV member name to a distinct group-member user ID). The import keeps transaction dates, expenses, and payments; summary rows are skipped, and the same CSV cannot be imported twice into one group. Mapped accounts must already belong to the group. Splitwise exports omit the original per-person shares for multiple-payer expenses, so exact pairwise debts cannot be reconstructed for those rows; SplitCare estimates the missing shares while preserving each transaction total and each member's net balance.
- `GET /api/groups/balances/summary` returns the signed-in user's total net balance, amounts owed and owing across shared groups and direct friend ledgers, converted to their default currency.
- `GET /api/groups/:groupId/balances` returns only the authenticated member's balances, with amounts owed to or by that member.
- `POST /api/groups/:groupId/payment-requests` accepts `{ "memberId": "group-member-user-id", "amount": "25.00", "currency": "INR", "note": "Optional message" }` to notify a member who currently owes the authenticated member. Requests are limited to the outstanding amount and appear in group activity; they do not change balances.
- `GET /api/groups/:groupId/whiteboard` and `PUT /api/groups/:groupId/whiteboard` let any current group member read or update the shared 5,000-character group whiteboard. Updates are recorded in group activity and notify the other members.
- `POST /api/groups/:groupId/settlements` accepts `multipart/form-data` with `payeeId`, `amount`, `currency`, optional `note`, and optional `paymentProof` image (up to 5 MB). The authenticated member is the payer. Payments are recorded in group activity and reduce their outstanding debt; in groups with debt simplification enabled, payments can follow the latest simplified plan.
- `PATCH /api/groups/:groupId` (any group member; accepts multipart fields `name`, `simplifyDebts` and optional `coverImage` image or `removeCoverImage=true`)
- `DELETE /api/groups/:groupId/members/:memberId` removes another member when their group balances are settled; any current member can request it, but the creator and requester cannot be removed through this endpoint.
- `DELETE /api/groups/:groupId` (group creator only; deletes the group and its expenses after all balances are settled)
- `POST /api/groups/:groupId/leave` (leaving requires the entire group to be settled; leaving as the last member deletes the group and its related data)
- `GET /api/expenses` returns recent expenses and activity across groups the signed-in user belongs to; add `history=true` for the complete cross-group history used by Recent activity and All expenses.
- `GET /api/expenses/personal` returns the signed-in user's solo personal expenses. The Personal expenses page can also be filtered to show only one-to-one expenses shared with a selected friend; group expenses remain on All expenses.
- The Recent activity page brings together group activity, direct friend-ledger activity, settlements, in-app notifications, and incoming friend requests in one chronological feed. The navigation bell opens a dropdown for pending friend requests, payment requests, and payments received; clicking outside closes it. The All expenses page shows expenses from all groups the signed-in user belongs to plus direct one-to-one friend expenses in the same ledger layout; private solo expenses stay on the separate Personal expenses page.
- `POST /api/expenses` accepts `multipart/form-data` with `description`, `totalAmount`, `currency`, `category`, optional `subcategory`, `groupId`, `paidBy`, `participants` (JSON array), `splitStrategy` (`EQUAL`, `EXACT`, `PERCENTAGE`, `SHARES`, `ADJUSTMENT`, `REIMBURSEMENT`, or `ITEMIZED`), `values` (JSON array when required), optional `items` (JSON array for itemized expenses), optional `paymentProof` image (up to 5 MB), and optional `note`. If `groupId` is omitted, the expense is stored in the account's private Personal Expenses group unless a friend is selected, in which case use `POST /api/friends/:friendId/expenses` to record a private one-to-one expense. Categories are Entertainment, Food and drink, Home, Life, Transportation, Uncategorized, and Utilities. Payment proof uploads use the configured Cloudinary account.
- `PATCH /api/expenses/:expenseId` accepts the same expense fields to update an existing entry. Any member of the expense's group can edit it; group balances and split/item details are recalculated, and all group members receive an in-app notification.
- `DELETE /api/expenses/:expenseId` lets a group member delete a group expense (only the account owner can delete a personal expense); balances are reversed and a permanent activity record remains in the group feed.
- `GET /api/expenses?groupId=<groupId>` includes comments on each expense. Add `history=true` to return all group expenses and activity instead of the latest 100 entries. The group Activity panel can search descriptions, member names, currencies, and amounts, and its Print / Save PDF action opens a printable all-expenses ledger with member balance changes. `POST /api/expenses/:expenseId/comments` accepts `{ "content": "Comment text" }` from any group member; `DELETE /api/expenses/comments/:commentId` lets the comment author remove their comment.
- `GET /api/users/notifications` lists all in-app notifications for the signed-in user; `PATCH /api/users/notifications/read` marks them as read.
- `GET /api/friends/requests/sent` lists friend requests sent by the signed-in user, including their status.
- `GET /api/friends/:friendId/history` returns private one-to-one expenses and friend payments, plus per-group balances and expense totals for groups shared with that friend. Group expense rows are not included in the personal friend ledger. Balances and totals are converted to the signed-in user's default currency.
- `GET /api/friends/activity` returns the signed-in user's direct friend-ledger expenses, settlements, and activity events. These are included in Recent activity; direct friend expenses also appear in All expenses, alongside group expenses.
- `POST /api/friends/:friendId/expenses` accepts the same multipart expense fields as `POST /api/expenses`, but limits the payer and participants to the signed-in user and that friend. `PATCH` and `DELETE /api/friends/:friendId/expenses/:expenseId` update or remove a direct friend expense; private ledger entries cannot be managed through the general group expense endpoints.
- `POST /api/friends/:friendId/settlements` accepts `{ "payerId": "user-id", "amount": "25.00", "currency": "INR", "mode": "selected", "selections": [{ "groupId": "group-id", "currency": "USD" }], "note": "Optional message" }`. `payerId` may be either friend, `mode` is `selected` or `all`, and `selections` is required for selected balances. The payment is recorded in the supplied currency, while each selected balance is reduced in its own currency using Frankfurter daily reference rates. Set `defaultCurrency` through the profile update endpoint to choose the currency used in the friend balance view and settlement form.
- From a group member list, `Add friend` sends a friend request directly to that member; the group displays whether you are already friends or a request is pending.
- `POST /api/groups/:groupId/leave`
- `GET /api/groups/:groupId/simplify-debts` recalculates suggested transfers from all current expenses and recorded payments. The group preference controls whether it combines member balances; suggestions do not change balances until a payment is recorded.
