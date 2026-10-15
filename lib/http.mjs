export const securityHeaders = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
};
export const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function json(res, status, body) { res.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
export function html(res, status, body) { res.writeHead(status, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8' }); res.end(body); }
export function redirect(res, location, status = 303) { res.writeHead(status, { ...securityHeaders, location }); res.end(); }
export function fail(status, message) { throw Object.assign(new Error(message), { statusCode: status }); }
export async function readBody(req) {
  const type = String(req.headers['content-type'] || '');
  let text;
  if (req.body !== undefined) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) text = type.includes('application/json') ? JSON.stringify(req.body) : new URLSearchParams(req.body).toString();
    else text = String(req.body);
  } else {
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 1024 * 1024) fail(413, 'Request too large'); chunks.push(chunk); }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(text) > 1024 * 1024) fail(413, 'Request too large');
  if (type.includes('application/json')) { try { return JSON.parse(text || '{}'); } catch { fail(400, 'Invalid JSON'); } }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  fail(415, 'Use JSON or form-encoded data');
}
export function cookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('='); if (index < 0) continue;
    try { result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* Ignore malformed cookies. */ }
  }
  return result;
}
export function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.COOKIE_SECURE === 'false' ? '' : '; Secure'}`;
}
export function safeReturn(value) { return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\r\n]/.test(value) ? value : '/'; }
