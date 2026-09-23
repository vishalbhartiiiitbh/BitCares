import dotenv from 'dotenv';
import mongoose from 'mongoose';
import app from './app.js';

dotenv.config();

const port = process.env.PORT || 5000;
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/splitcare';

const connectDB = async () => {
  try {
    const connectionInstance = await mongoose.connect(mongoUri);
    console.log(`MongoDB connected !! DB HOST: ${connectionInstance.connection.host}`);

    app.listen(port, () => {
      console.log(`SplitCare API listening on port ${port}`);
    });
  } catch (error) {
    console.error('MONGODB connection error: ', error);
    process.exit(1);
  }
};

connectDB();
