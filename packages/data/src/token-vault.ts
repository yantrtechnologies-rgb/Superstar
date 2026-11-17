import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ProviderConfigurationError } from './provider-contract';

function encryptionKey() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;
  if (!value || !/^[A-Za-z0-9+\/]{43}=$/.test(value)) {
    throw new ProviderConfigurationError('Configure a base64-encoded 32-byte token encryption key.');
  }
  return Buffer.from(value, 'base64');
}

export function vaultConfigured() {
  try {
    return encryptionKey().length === 32;
  } catch {
    return false;
  }
}

export function sealToken(token: string, binding: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(binding));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function openToken(sealed: string, binding: string) {
  try {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Invalid encrypted token');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new ProviderConfigurationError('Stored credentials could not be opened. Reconnect the account.');
  }
}
