import crypto from 'node:crypto';

/**
 * Generates a cryptographically secure random bearer token.
 * @returns {string}
 */
export function generateBridgeToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Verifies an HTTP Authorization header against the expected bearer token
 * using a constant-time comparison.
 * @param {string | undefined} authHeader
 * @param {string} expectedToken
 * @returns {boolean}
 */
export function verifyBearerToken(authHeader, expectedToken) {
  if (typeof authHeader !== 'string' || typeof expectedToken !== 'string' || !expectedToken) {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) {
    return false;
  }
  const provided = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(provided, expected);
}
