import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateOrder,
  InvalidOrderError,
  ORDER_STATUS,
  ORDER_STATUS_MESSAGES,
  ORDER_ID_MAX_LENGTH,
} from '../src/domain.mjs';

function expectInvalid(input) {
  assert.throws(
    () => evaluateOrder(input),
    (error) => {
      assert.ok(error instanceof InvalidOrderError, 'expected InvalidOrderError');
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    },
  );
}

test('unpaid order is WAITING_PAYMENT', () => {
  const result = evaluateOrder({ orderId: 'ORD-1001', paid: false, stock: false });
  assert.equal(result.status, ORDER_STATUS.WAITING_PAYMENT);
  assert.equal(result.status, 'WAITING_PAYMENT');
  assert.equal(result.message, ORDER_STATUS_MESSAGES.WAITING_PAYMENT);
  assert.match(result.message, /支付/);
  assert.equal(result.orderId, 'ORD-1001');
  assert.equal(result.paid, false);
  assert.equal(result.stock, false);
});

test('unpaid order stays WAITING_PAYMENT even when stock exists', () => {
  const result = evaluateOrder({ orderId: 'ORD-1002', paid: false, stock: true });
  assert.equal(result.status, 'WAITING_PAYMENT');
});

test('paid order without stock is WAITING_STOCK', () => {
  const result = evaluateOrder({ orderId: 'ORD-2001', paid: true, stock: false });
  assert.equal(result.status, ORDER_STATUS.WAITING_STOCK);
  assert.equal(result.status, 'WAITING_STOCK');
  assert.equal(result.message, ORDER_STATUS_MESSAGES.WAITING_STOCK);
  assert.match(result.message, /库存/);
});

test('paid order with stock is READY_TO_SHIP', () => {
  const result = evaluateOrder({ orderId: 'ORD-3001', paid: true, stock: true });
  assert.equal(result.status, ORDER_STATUS.READY_TO_SHIP);
  assert.equal(result.status, 'READY_TO_SHIP');
  assert.equal(result.message, ORDER_STATUS_MESSAGES.READY_TO_SHIP);
  assert.match(result.message, /发货/);
});

test('orderId is trimmed before it is returned', () => {
  const result = evaluateOrder({ orderId: '  ORD-4001  ', paid: true, stock: true });
  assert.equal(result.orderId, 'ORD-4001');
});

test('orderId of exactly the maximum length is accepted', () => {
  const orderId = 'a'.repeat(ORDER_ID_MAX_LENGTH);
  const result = evaluateOrder({ orderId, paid: true, stock: false });
  assert.equal(result.orderId, orderId);
});

test('orderId of one character is accepted', () => {
  const result = evaluateOrder({ orderId: 'x', paid: false, stock: false });
  assert.equal(result.orderId, 'x');
});

test('empty orderId is invalid', () => {
  expectInvalid({ orderId: '', paid: true, stock: true });
});

test('whitespace-only orderId is invalid', () => {
  expectInvalid({ orderId: '   ', paid: true, stock: true });
});

test('missing orderId is invalid', () => {
  expectInvalid({ paid: true, stock: true });
});

test('non-string orderId is invalid', () => {
  expectInvalid({ orderId: 12345, paid: true, stock: true });
});

test('orderId longer than the maximum is invalid', () => {
  expectInvalid({ orderId: 'a'.repeat(ORDER_ID_MAX_LENGTH + 1), paid: true, stock: true });
});

test('non-boolean paid is invalid', () => {
  expectInvalid({ orderId: 'ORD-5001', paid: 'true', stock: true });
  expectInvalid({ orderId: 'ORD-5001', paid: 1, stock: true });
  expectInvalid({ orderId: 'ORD-5001', stock: true });
});

test('non-boolean stock is invalid', () => {
  expectInvalid({ orderId: 'ORD-5002', paid: true, stock: 'false' });
  expectInvalid({ orderId: 'ORD-5002', paid: true, stock: 0 });
  expectInvalid({ orderId: 'ORD-5002', paid: true });
});

test('null, array and primitive inputs are invalid', () => {
  expectInvalid(null);
  expectInvalid([]);
  expectInvalid('ORD-6001');
  expectInvalid(undefined);
});
