import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import expenseRoutes from './routes/expenseRoutes.js';
import groupRoutes from './routes/groupRoutes.js';
import userRoutes from './routes/userRoutes.js';
import friendRoutes from './routes/friendRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import billingRoutes from './routes/billingRoutes.js';
import './listeners/notificationListener.js';
import { errorHandler } from './middlewares/errorHandler.js';

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '16kb', verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
app.use(express.urlencoded({ extended: true, limit: '16kb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});
app.use('/api/expenses', expenseRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/users', userRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/billing', billingRoutes);
app.use((req, res) => {
  res.status(404).json({
    error: 'That page or endpoint couldn’t be found. Check the address and try again.',
  });
});
app.use(errorHandler);

export default app;
