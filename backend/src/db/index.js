import mongoose from 'mongoose';

const connectDB = async () => {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/splitcare';
  const dbName = process.env.DB_NAME || undefined;

  try {
    const connection = await mongoose.connect(mongoUri, {
      dbName,
    });

    console.log(`MongoDB connected: ${connection.connection.host}/${connection.connection.name}`);
    return connection;
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    throw error;
  }
};

export default connectDB;