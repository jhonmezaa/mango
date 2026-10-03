/** `otpauth://` URI for authenticator apps (Key Uri Format); issuer "Mango". */
export function otpauthUri(secret: string, account: string): string {
  const label = encodeURIComponent(`Mango:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer: 'Mango',
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The secret in groups of four for reading and typing (design `mfa-secret`). */
export function groupSecret(secret: string): string {
  return secret.replace(/=+$/, '').replace(/(.{4})(?=.)/g, '$1 ');
}

/** Dark modules of the QR code, generated locally (no external service, TM-L1). */
export async function qrMatrix(text: string): Promise<boolean[][]> {
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => qr.isDark(row, col)),
  );
}
