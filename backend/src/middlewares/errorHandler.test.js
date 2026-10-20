import assert from 'node:assert/strict';
import test from 'node:test';
import { errorHandler } from './errorHandler.js';

const runErrorHandler = (error) => {
  let status;
  let body;
  errorHandler(error, { method: 'GET', path: '/api/test' }, {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  }, () => {});
  return { status, body };
};

test('returns a friendly message without exposing unexpected server errors', () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = runErrorHandler(new Error('database connection string and query details'));
    assert.equal(result.status, 500);
    assert.equal(result.body.error, "We couldn't complete your request right now. Please try again in a moment.");
    assert.doesNotMatch(result.body.error, /database|connection string|query details/i);
  } finally {
    console.error = originalConsoleError;
  }
});

test('preserves helpful messages for expected client validation errors', () => {
  const result = runErrorHandler(Object.assign(new Error('Enter a valid group name'), { statusCode: 400 }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'Enter a valid group name');
});

test('uses a helpful sign-in message for invalid authentication tokens', () => {
  const result = runErrorHandler(Object.assign(new Error('sensitive token detail'), { name: 'JsonWebTokenError' }));
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'Your sign-in session is no longer valid. Please sign in again.');
});
