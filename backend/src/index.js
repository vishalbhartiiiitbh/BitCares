import 'dotenv/config';
import app from './app.js';
import connectDB from './db/index.js';
import { startEmailNotificationWorker } from './services/emailNotificationService.js';
const port = process.env.PORT || 5000;

connectDB()
  .then(() => {
    startEmailNotificationWorker();
    app.listen(port, () => {
      console.log(`SplitCare API listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error('Backend startup failed:', error.message);
    process.exit(1);
  });
