// Shared order ID validation for the Order Status Board UI.
//
// Kept in a standalone ES module (no DOM access) so the exact same rule used by
// the browser can be exercised by node:test, and so it stays aligned with the
// server domain in `src/domain.mjs`, which counts Unicode code points via
// `[...orderId].length`.

export const ORDER_ID_MIN_LENGTH = 1;
export const ORDER_ID_MAX_LENGTH = 40;

/**
 * Count the characters of an order ID the same way the backend domain does:
 * by Unicode code points, not UTF-16 code units. A supplementary character
 * such as an emoji therefore counts as one character in both layers.
 *
 * @param {string} value
 * @returns {number}
 */
export function countOrderIdCharacters(value) {
  return [...String(value)].length;
}

/**
 * Trim and validate a raw order ID coming from the input element.
 *
 * @param {unknown} rawValue
 * @returns {{ ok: true, orderId: string, error: '' } | { ok: false, orderId: string, error: string }}
 */
export function validateOrderId(rawValue) {
  const orderId = typeof rawValue === "string" ? rawValue.trim() : "";
  const length = countOrderIdCharacters(orderId);

  if (length < ORDER_ID_MIN_LENGTH) {
    return { ok: false, orderId, error: "请输入订单号。" };
  }
  if (length > ORDER_ID_MAX_LENGTH) {
    return { ok: false, orderId, error: `订单号最多 ${ORDER_ID_MAX_LENGTH} 个字符。` };
  }
  return { ok: true, orderId, error: "" };
}
