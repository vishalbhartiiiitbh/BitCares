export const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export const errorHandler = (error, _req, res, _next) => {
  const status = error.statusCode ||
    (error.name === 'ValidationError' || error.code === 11000 ? 400 : 500);
  const authError = ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name);
  const resolvedStatus = authError ? 401 : status;
  res.status(resolvedStatus).json({ error: error.message || 'Internal server error' });
};