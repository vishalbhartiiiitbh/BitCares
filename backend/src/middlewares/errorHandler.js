export const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const genericServerError = "We couldn't complete your request right now. Please try again in a moment.";

export const errorHandler = (error, req, res, _next) => {
  const authError = ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name);
  const parserError = ['entity.parse.failed', 'entity.too.large'].includes(error.type);
  const corsError = error.message === 'Origin not allowed by CORS';
  const knownClientError = ['ValidationError', 'MulterError'].includes(error.name) || error.code === 11000;
  const suppliedStatus = Number(error.statusCode || error.status);
  const status = authError
    ? 401
    : corsError
      ? 403
      : parserError
        ? (error.type === 'entity.too.large' ? 413 : 400)
        : knownClientError
          ? 400
        : Number.isInteger(suppliedStatus) && suppliedStatus >= 400 && suppliedStatus < 600
          ? suppliedStatus
          : 500;

  if (status >= 500) {
    console.error('Unhandled API request error', {
      method: req.method,
      path: req.path,
      name: error.name,
      code: error.code,
    });
    return res.status(status).json({ error: genericServerError });
  }

  if (parserError) {
    const message = status === 413
      ? 'That request is too large. Please reduce its size and try again.'
      : 'We couldn’t read that request. Check the information and try again.';
    return res.status(status).json({ error: message });
  }

  if (corsError) {
    return res.status(status).json({ error: 'This request could not be accepted from this website.' });
  }

  if (error.name === 'MulterError') {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'That file is too large. Choose a smaller file and try again.'
      : 'We couldn’t process that upload. Check the file and try again.';
    return res.status(status).json({ error: message });
  }

  if (authError) {
    return res.status(status).json({ error: 'Your sign-in session is no longer valid. Please sign in again.' });
  }

  return res.status(status).json({
    error: error.message || 'We couldn’t complete that request. Please check your information and try again.',
  });
};
