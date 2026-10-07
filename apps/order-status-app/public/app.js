// Order Status Board — dependency-free single-page controller.
// Posts to the JSON API and renders the returned status code + Chinese message.

import { validateOrderId } from "./order-id.mjs";

const API_URL = "/api/orders/evaluate";
const REQUEST_TIMEOUT_MS = 10000;

const STATUS_ZH = {
  WAITING_PAYMENT: "等待支付",
  WAITING_STOCK: "等待库存",
  READY_TO_SHIP: "可以发货",
};

const UI = {
  form: document.getElementById("order-form"),
  orderId: document.getElementById("order-id"),
  orderIdError: document.getElementById("order-id-error"),
  paid: document.getElementById("paid"),
  stock: document.getElementById("stock"),
  submit: document.getElementById("submit-button"),
  result: document.getElementById("result"),
  resultCode: document.getElementById("result-code"),
  resultMessage: document.getElementById("result-message"),
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setLoading(isLoading) {
  UI.submit.disabled = isLoading;
  UI.submit.setAttribute("aria-busy", String(isLoading));
  UI.submit.classList.toggle("is-loading", isLoading);
  UI.form.setAttribute("aria-busy", String(isLoading));
}

function clearOrderIdError() {
  UI.orderIdError.hidden = true;
  UI.orderIdError.textContent = "";
  UI.orderId.setAttribute("aria-invalid", "false");
}

function showOrderIdError(message) {
  UI.orderIdError.textContent = message;
  UI.orderIdError.hidden = false;
  UI.orderId.setAttribute("aria-invalid", "true");
  UI.orderId.focus();
}

function renderResult(kind, code, message) {
  UI.result.hidden = false;
  UI.result.classList.remove("result--waiting", "result--stock", "result--ready", "result--error");

  const toneClass = {
    WAITING_PAYMENT: "result--waiting",
    WAITING_STOCK: "result--stock",
    READY_TO_SHIP: "result--ready",
  }[code];

  UI.result.classList.add(kind === "error" ? "result--error" : toneClass || "result--info");
  UI.resultCode.textContent = code;
  UI.resultMessage.textContent = message;
  UI.result.focus({ preventScroll: true });
}

/** Read a JSON body without throwing on empty or malformed payloads. */
async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessageFrom(payload, httpStatus) {
  if (isObject(payload)) {
    const error = isObject(payload.error) ? payload.error : payload;
    if (typeof error.message === "string" && error.message.trim() !== "") {
      return error.message;
    }
  }
  return `请求失败（HTTP ${httpStatus}）`;
}

function errorCodeFrom(payload, httpStatus) {
  if (isObject(payload)) {
    const error = isObject(payload.error) ? payload.error : payload;
    const code = firstNonEmptyString(error.code, error.status);
    if (code) return code;
  }
  return `HTTP_${httpStatus}`;
}

/** Return the first argument that is a non-empty string, otherwise "". */
function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

async function evaluateOrder(orderId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        paid: UI.paid.checked,
        stock: UI.stock.checked,
      }),
      signal: controller.signal,
    });

    const payload = await readJson(response);

    if (!response.ok) {
      renderResult(
        "error",
        errorCodeFrom(payload, response.status),
        errorMessageFrom(payload, response.status),
      );
      return;
    }

    const status = isObject(payload)
      ? firstNonEmptyString(payload.status, payload.code)
      : "";
    const resolvedStatus = status || "UNKNOWN";
    const message = isObject(payload)
      ? firstNonEmptyString(payload.message, payload.detail, STATUS_ZH[resolvedStatus]) || "评估完成"
      : "评估完成";

    renderResult("success", resolvedStatus, message);
  } catch (error) {
    const aborted = Boolean(error) && error.name === "AbortError";
    renderResult(
      "error",
      aborted ? "TIMEOUT" : "NETWORK_ERROR",
      aborted ? "请求超时，请稍后重试。" : "网络错误，无法连接服务器，请检查网络后重试。",
    );
  } finally {
    clearTimeout(timer);
  }
}

UI.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (UI.submit.disabled) return;

  clearOrderIdError();
  const validation = validateOrderId(UI.orderId.value);
  if (!validation.ok) {
    showOrderIdError(validation.error);
    return;
  }

  setLoading(true);
  try {
    await evaluateOrder(validation.orderId);
  } finally {
    setLoading(false);
  }
});

UI.orderId.addEventListener("input", () => {
  if (!UI.orderIdError.hidden) clearOrderIdError();
});
