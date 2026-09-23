# SplitCare

SplitCare is an expense-sharing application with a Node.js, Express, and MongoDB backend.

## Backend Setup

```bash
cd backend
npm install
cp .env.example .env
```

Update `backend/.env` with your MongoDB URI and private JWT, Cloudinary, and other credentials. Do not commit `.env`.

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
