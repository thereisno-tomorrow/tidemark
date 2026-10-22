import assert from 'node:assert/strict';
import test from 'node:test';
import { formatReleaseTag } from '../../lib/git.mjs';

test('release tags are UTC, collision resistant, and commit bound', () => {
  const tag = formatReleaseTag(new Date('2026-07-31T12:34:56Z'), 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(tag, 'agent-config-v20260731.123456-abcdef012345');
});
