import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET } from '../apps/web/app/health/route.ts';

test('web health endpoint returns a successful JSON probe', async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
