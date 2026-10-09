'use strict';

const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/**
 * Parse a WWW-Authenticate header (may contain several challenges, e.g. Digest + Basic).
 * Returns the Digest challenge if present, otherwise the Basic one.
 */
function parseChallenge(headerValues) {
  const values = Array.isArray(headerValues) ? headerValues : [headerValues];
  let basic = null;
  for (const value of values) {
    if (!value) continue;
    const scheme = value.trim().split(/\s+/)[0].toLowerCase();
    if (scheme === 'digest') {
      const params = {};
      const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
      let m;
      while ((m = re.exec(value)) !== null) {
        params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
      }
      return { scheme: 'digest', ...params };
    }
    if (scheme === 'basic') basic = { scheme: 'basic' };
  }
  return basic;
}

/**
 * Build an Authorization header value for the given challenge.
 * `state` carries the nonce count between calls that reuse the same challenge.
 */
function authorization(challenge, method, uri, username, password, state = {}) {
  if (!challenge) return undefined;
  if (challenge.scheme === 'basic') {
    return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  const algorithm = (challenge.algorithm || 'MD5').toUpperCase();
  const qop = challenge.qop ? challenge.qop.split(',').map((q) => q.trim()).find((q) => q === 'auth') : undefined;

  let ha1 = md5(`${username}:${realm}:${password}`);
  const cnonce = crypto.randomBytes(8).toString('hex');
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}"`;
  if (qop) {
    state.nc = (state.nc || 0) + 1;
    const nc = state.nc.toString(16).padStart(8, '0');
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  } else {
    header += `, response="${md5(`${ha1}:${nonce}:${ha2}`)}"`;
  }
  if (challenge.opaque) header += `, opaque="${challenge.opaque}"`;
  if (challenge.algorithm) header += `, algorithm=${challenge.algorithm}`;
  return header;
}

module.exports = { parseChallenge, authorization };
