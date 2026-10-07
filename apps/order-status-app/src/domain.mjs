/**
 * Order fulfillment domain rules for the Order Status Board.
 *
 * Zero third-party dependencies. ES module.
 */

export const ORDER_STATUS = Object.freeze({
  WAITING_PAYMENT: 'WAITING_PAYMENT',
  WAITING_STOCK: 'WAITING_STOCK',
  READY_TO_SHIP: 'READY_TO_SHIP',
});

export const ORDER_STATUS_MESSAGES = Object.freeze({
  [ORDER_STATUS.WAITING_PAYMENT]: '订单尚未支付，等待买家付款',
  [ORDER_STATUS.WAITING_STOCK]: '订单已支付，等待库存补充',
  [ORDER_STATUS.READY_TO_SHIP]: '订单已支付且有库存，可以发货',
});

export const ORDER_ID_MIN_LENGTH = 1;
export const ORDER_ID_MAX_LENGTH = 40;

/**
 * Error raised when the evaluation input does not satisfy the domain contract.
 * `code` is always `INVALID_INPUT` so the HTTP layer can map it to a 400.
 */
export class InvalidOrderError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'InvalidOrderError';
    this.code = code;
  }
}

function invalid(message) {
  throw new InvalidOrderError(message);
}

/**
 * Evaluate an order against the fulfillment state machine.
 *
 * Rules:
 *   - not paid                -> WAITING_PAYMENT
 *   - paid but no stock       -> WAITING_STOCK
 *   - paid and stock available-> READY_TO_SHIP
 *
 * Validation:
 *   - `orderId` must be a string whose trimmed length is 1-40 characters.
 *   - `paid` and `stock` must be booleans.
 *
 * @param {{ orderId: unknown, paid: unknown, stock: unknown }} input
 * @returns {{ orderId: string, paid: boolean, stock: boolean, status: string, message: string }}
 * @throws {InvalidOrderError} when the input is invalid
 */
export function evaluateOrder(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('请求体必须是包含 orderId、paid、stock 的 JSON 对象');
  }

  const { orderId, paid, stock } = input;

  if (typeof orderId !== 'string') {
    invalid('orderId 必须是字符串');
  }

  const normalizedOrderId = orderId.trim();
  const orderIdLength = [...normalizedOrderId].length;
  if (orderIdLength < ORDER_ID_MIN_LENGTH || orderIdLength > ORDER_ID_MAX_LENGTH) {
    invalid(`orderId 去除首尾空格后长度必须在 ${ORDER_ID_MIN_LENGTH}-${ORDER_ID_MAX_LENGTH} 个字符之间`);
  }

  if (typeof paid !== 'boolean') {
    invalid('paid 必须是布尔值');
  }

  if (typeof stock !== 'boolean') {
    invalid('stock 必须是布尔值');
  }

  let status;
  if (!paid) {
    status = ORDER_STATUS.WAITING_PAYMENT;
  } else if (!stock) {
    status = ORDER_STATUS.WAITING_STOCK;
  } else {
    status = ORDER_STATUS.READY_TO_SHIP;
  }

  return {
    orderId: normalizedOrderId,
    paid,
    stock,
    status,
    message: ORDER_STATUS_MESSAGES[status],
  };
}
