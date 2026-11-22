const encoder = new TextEncoder();
export const PASSWORD_ITERATIONS = 600_000;
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function newId(): string {
  return crypto.randomUUID();
}

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return toBase64Url(value);
}

export function randomPassword(): string {
  return randomToken(24);
}

export function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(value.length / 2));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    hash: await derivePassword(password, salt, PASSWORD_ITERATIONS),
    salt: toHex(salt),
    iterations: PASSWORD_ITERATIONS,
  };
}

export async function verifyPassword(
  password: string,
  saltHex: string,
  expectedHash: string,
  iterations: number,
): Promise<boolean> {
  if (iterations < 100_000 || iterations > 2_000_000 || !/^[\da-f]{32,}$/iu.test(saltHex)) return false;
  const actual = await derivePassword(password, fromHex(saltHex), iterations);
  return constantTimeEqual(actual, expectedHash.toLowerCase());
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = new Uint8Array(salt.byteLength);
  saltBuffer.set(salt);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations }, material, 256);
  return toHex(new Uint8Array(bits));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export function normalizeEmail(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return undefined;
}

export function sessionCookieName(appMode: string): string {
  return appMode === "development" ? "zellink_session" : "__Host-zellink_session";
}

export function sessionCookie(token: string, appMode: string): string {
  const secure = appMode === "development" ? "" : "; Secure";
  return `${sessionCookieName(appMode)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearSessionCookie(appMode: string): string {
  const secure = appMode === "development" ? "" : "; Secure";
  return `${sessionCookieName(appMode)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
