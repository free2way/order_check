/**
 * Focused boundary tests for the shared order ID validation used by the UI.
 *
 * The regression this covers: the browser must not measure the order ID in
 * UTF-16 code units anywhere, because the server domain (`src/domain.mjs`)
 * measures Unicode code points. A 40-emoji identifier is 80 UTF-16 code units
 * but exactly 40 code points, so the frontend and backend must both accept it.
 *
 * Uses node:test/assert only. No dependencies, no DOM required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ORDER_ID_MAX_LENGTH,
  countOrderIdCharacters,
  validateOrderId,
} from '../public/order-id.mjs';
import { evaluateOrder } from '../src/domain.mjs';

// Supplementary-plane character: 2 UTF-16 code units, 1 Unicode code point.
const EMOJI = '\u{1F600}';
const FORTY_EMOJI = EMOJI.repeat(40);
const FORTY_ONE_EMOJI = EMOJI.repeat(41);

test('countOrderIdCharacters counts code points, not UTF-16 code units', () => {
  assert.equal(FORTY_EMOJI.length, 80, 'sanity: 40 emoji occupy 80 UTF-16 units');
  assert.equal(countOrderIdCharacters(FORTY_EMOJI), 40);
  assert.equal(countOrderIdCharacters('abc'), 3);
  assert.equal(countOrderIdCharacters(''), 0);
});

test('validateOrderId accepts a 40-code-point supplementary Unicode order ID', () => {
  const result = validateOrderId(FORTY_EMOJI);
  assert.equal(result.ok, true);
  assert.equal(result.orderId, FORTY_EMOJI);
  assert.equal(result.error, '');
});

test('validateOrderId trims before measuring and returns the trimmed id', () => {
  const result = validateOrderId(`  ${FORTY_EMOJI}  `);
  assert.equal(result.ok, true);
  assert.equal(result.orderId, FORTY_EMOJI);
});

test('validateOrderId rejects a 41-code-point supplementary Unicode order ID', () => {
  const result = validateOrderId(FORTY_ONE_EMOJI);
  assert.equal(result.ok, false);
  assert.match(result.error, new RegExp(String(ORDER_ID_MAX_LENGTH)));
});

test('validateOrderId rejects empty and whitespace-only input', () => {
  for (const value of ['', '   ', undefined, null]) {
    const result = validateOrderId(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.ok(result.error.length > 0);
  }
});

test('frontend and domain agree on the Unicode order ID boundary', () => {
  // Accepted at 40 code points by the shared UI validator...
  const accepted = validateOrderId(FORTY_EMOJI);
  assert.equal(accepted.ok, true);
  // ...and by the server domain.
  const evaluated = evaluateOrder({ orderId: FORTY_EMOJI, paid: true, stock: false });
  assert.equal(evaluated.orderId, FORTY_EMOJI);
  assert.equal(evaluated.status, 'WAITING_STOCK');

  // Rejected at 41 code points by the shared UI validator...
  assert.equal(validateOrderId(FORTY_ONE_EMOJI).ok, false);
  // ...and by the server domain.
  assert.throws(
    () => evaluateOrder({ orderId: FORTY_ONE_EMOJI, paid: true, stock: false }),
    (error) => error?.code === 'INVALID_INPUT',
  );
});
