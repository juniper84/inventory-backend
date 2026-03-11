import crypto from 'crypto';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto
    .scryptSync(password, salt, SCRYPT_KEYLEN)
    .toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, passwordHash: string) {
  const [salt, stored] = passwordHash.split(':');
  if (!salt || !stored) {
    return false;
  }
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const storedBuffer = Buffer.from(stored, 'hex');
  return (
    storedBuffer.length === derived.length &&
    crypto.timingSafeEqual(storedBuffer, derived)
  );
}

export function validatePassword(password: string) {
  const hasMinLength = password.length >= 8;
  // G1-L1: Enforce max length to prevent DoS via extremely long passwords
  // (bcrypt/scrypt with a 10kb password can consume significant CPU).
  const hasMaxLength = password.length <= 128;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /\d/.test(password);
  return hasMinLength && hasMaxLength && hasLetter && hasNumber;
}
