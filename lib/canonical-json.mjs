import { createHash } from 'node:crypto';

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalize(value[key])]),
    );
  }
  return value;
}

export function canonicalize(value) {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

export function digestObject(value) {
  return `sha256:${sha256(canonicalize(value))}`;
}

export function withContentId(value, field = 'planId') {
  const normalized = structuredClone(value);
  delete normalized[field];
  return { ...normalized, [field]: digestObject(normalized) };
}
