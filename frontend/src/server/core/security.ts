import { createHash, randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";

import { settings } from "../config";

export const utcnow = () => new Date();

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 12);
}

export function verifyPassword(password: string, passwordHash: string | null | undefined): boolean {
  if (!passwordHash) return false;
  try {
    return bcrypt.compareSync(password, passwordHash);
  } catch {
    return false;
  }
}

export function createToken(subject: string, purpose: string, minutes: number, sessionId?: string | null): string {
  const payload: Record<string, unknown> = { sub: subject, purpose };
  if (sessionId) payload.sid = sessionId;
  return jwt.sign(payload, settings.JWT_SECRET, { algorithm: settings.JWT_ALGORITHM, expiresIn: minutes * 60 });
}

/** Throws if the token is invalid or expired. */
export function decodeToken(token: string): Record<string, any> {
  return jwt.verify(token, settings.JWT_SECRET, { algorithms: [settings.JWT_ALGORITHM] }) as Record<string, any>;
}

authenticator.options = { window: 1 };

export const newTotpSecret = () => authenticator.generateSecret();

export function totpUri(secret: string, email: string): string {
  return authenticator.keyuri(email, settings.MFA_ISSUER, secret);
}

export function verifyTotp(secret: string, code: string): boolean {
  try {
    return authenticator.check(code.trim(), secret);
  } catch {
    return false;
  }
}

export function hashApiKey(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

/** Returns [plain_key, prefix, sha256_hash]. The plain key is shown once only. */
export function newApiKey(): [string, string, string] {
  const prefix = randomBytes(4).toString("hex");
  const plain = `eqf_${prefix}_${randomBytes(32).toString("base64url")}`;
  return [plain, prefix, hashApiKey(plain)];
}
