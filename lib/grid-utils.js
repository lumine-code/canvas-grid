const { MIN_RESIZED_COLUMN_WIDTH } = require("./constants");

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeInteger(value, fallback, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.floor(number))
    : fallback;
}

function normalizeNullableCount(value) {
  return value == null ? null : normalizeInteger(value, 0);
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function disposable(callback) {
  return { dispose: callback };
}

function setHiddenAccessibleStyle(element) {
  Object.assign(element.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    border: "0",
  });
}

function formatCell(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return `[BLOB ${value.length} bytes]`;
  }
  if (value instanceof Uint8Array) return `[BLOB ${value.byteLength} bytes]`;
  return String(value);
}

function utf8ByteLength(value) {
  const text = String(value);
  if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
  return new TextEncoder().encode(text).byteLength;
}

function normalizeColumns(columns) {
  return (Array.isArray(columns) ? columns : []).map((column, index) => {
    if (typeof column === "string") {
      return {
        key: index,
        label: column,
        index,
        width: null,
        align: "left",
        formatCell: null,
        paintCell: null,
      };
    }
    const value = column || {};
    return {
      key: value.key ?? index,
      label: String(value.label ?? value.name ?? value.key ?? index + 1),
      index,
      width: Number.isFinite(value.width)
        ? Math.max(MIN_RESIZED_COLUMN_WIDTH, value.width)
        : null,
      align: ["left", "center", "right"].includes(value.align)
        ? value.align
        : "left",
      formatCell:
        typeof value.formatCell === "function"
          ? value.formatCell
          : typeof value.format === "function"
            ? value.format
            : null,
      paintCell: typeof value.paintCell === "function" ? value.paintCell : null,
      sortDirection:
        value.sortDirection === 1 || value.sortDirection === -1
          ? value.sortDirection
          : null,
    };
  });
}

function rowValue(row, column) {
  if (row == null) return undefined;
  return Array.isArray(row) ? row[column.index] : row[column.key];
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

module.exports = {
  clamp,
  disposable,
  formatCell,
  isAbortError,
  lowerBound,
  normalizeColumns,
  normalizeInteger,
  normalizeNullableCount,
  rowValue,
  setHiddenAccessibleStyle,
  utf8ByteLength,
};
