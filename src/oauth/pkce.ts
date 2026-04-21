import { createHash, randomBytes } from 'node:crypto';

/** Generate a cryptographically random PKCE code verifier (43-128 chars). */
export function newVerifier(): string {
  return base64url(randomBytes(32));
}

/** Compute the S256 challenge for a verifier. */
export function challenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** Random opaque state value, used to match the /callback to our flow. */
export function newState(): string {
  return base64url(randomBytes(32));
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
