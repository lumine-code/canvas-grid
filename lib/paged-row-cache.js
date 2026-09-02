const {
  DEFAULT_PAGE_SIZE,
  MAX_CACHED_PAGES,
  SAMPLE_ROWS,
} = require("./constants");
const { isAbortError, normalizeInteger } = require("./grid-utils");

/** A generation-safe, three-page cache around an offset/limit row loader. */
class PagedRowCache {
  constructor({
    fetchRows,
    rowCount = 0,
    pageSize = DEFAULT_PAGE_SIZE,
    onDidChange,
    onDidError,
  } = {}) {
    this.fetchRows = fetchRows;
    this.rowCount = normalizeInteger(rowCount, 0);
    this.pageSize = normalizeInteger(pageSize, DEFAULT_PAGE_SIZE, 1);
    this.onDidChange = onDidChange;
    this.onDidError = onDidError;
    this.entries = new Map();
    this.generation = 0;
    this.clock = 0;
    this.destroyed = false;
  }

  get size() {
    return this.entries.size;
  }

  get loading() {
    for (const entry of this.entries.values()) {
      if (entry.status === "loading") return true;
    }
    return false;
  }

  configure({
    fetchRows = this.fetchRows,
    rowCount = this.rowCount,
    pageSize = this.pageSize,
  } = {}) {
    const nextPageSize = normalizeInteger(pageSize, DEFAULT_PAGE_SIZE, 1);
    const changed =
      fetchRows !== this.fetchRows || nextPageSize !== this.pageSize;
    this.fetchRows = fetchRows;
    this.rowCount = normalizeInteger(rowCount, 0);
    this.pageSize = nextPageSize;
    if (changed) this.clear();
    else this.trimToRowCount();
  }

  trimToRowCount() {
    const lastPage =
      this.rowCount > 0 ? Math.floor((this.rowCount - 1) / this.pageSize) : -1;
    for (const pageIndex of Array.from(this.entries.keys())) {
      if (pageIndex > lastPage) this.deletePage(pageIndex);
    }
  }

  clear() {
    this.generation++;
    for (const pageIndex of Array.from(this.entries.keys()))
      this.deletePage(pageIndex);
    this.onDidChange?.();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
  }

  deletePage(pageIndex) {
    const entry = this.entries.get(pageIndex);
    if (!entry) return;
    entry.controller?.abort();
    this.entries.delete(pageIndex);
  }

  pageForRow(rowIndex) {
    return Math.floor(rowIndex / this.pageSize);
  }

  stateForRow(rowIndex) {
    if (rowIndex < 0 || rowIndex >= this.rowCount)
      return { status: "missing", row: undefined };
    const pageIndex = this.pageForRow(rowIndex);
    const entry = this.entries.get(pageIndex);
    if (!entry) return { status: "missing", row: undefined };
    entry.lastUsed = ++this.clock;
    if (entry.status !== "loaded")
      return { status: entry.status, row: undefined, error: entry.error };
    return {
      status: "loaded",
      row: entry.rows[rowIndex - pageIndex * this.pageSize],
    };
  }

  loadedRows(limit = SAMPLE_ROWS) {
    const rows = [];
    for (const pageIndex of Array.from(this.entries.keys()).sort(
      (left, right) => left - right,
    )) {
      const entry = this.entries.get(pageIndex);
      if (entry?.status !== "loaded") continue;
      for (const row of entry.rows) {
        rows.push(row);
        if (rows.length >= limit) return rows;
      }
    }
    return rows;
  }

  retainPages(pageIndexes) {
    if (this.destroyed) return Promise.resolve([]);
    const maxPage =
      this.rowCount > 0 ? Math.floor((this.rowCount - 1) / this.pageSize) : -1;
    const wanted = [];
    for (const value of pageIndexes || []) {
      const pageIndex = normalizeInteger(value, -1, -1);
      if (pageIndex < 0 || pageIndex > maxPage || wanted.includes(pageIndex))
        continue;
      wanted.push(pageIndex);
      if (wanted.length === MAX_CACHED_PAGES) break;
    }
    const wantedSet = new Set(wanted);
    for (const pageIndex of Array.from(this.entries.keys())) {
      if (!wantedSet.has(pageIndex)) this.deletePage(pageIndex);
    }
    return Promise.all(wanted.map((pageIndex) => this.loadPage(pageIndex)));
  }

  evictOne(exceptPage) {
    let candidate = null;
    for (const [pageIndex, entry] of this.entries) {
      if (pageIndex === exceptPage) continue;
      if (!candidate || entry.lastUsed < candidate.entry.lastUsed)
        candidate = { pageIndex, entry };
    }
    if (candidate) this.deletePage(candidate.pageIndex);
  }

  loadPage(pageIndex) {
    if (this.destroyed || pageIndex < 0 || !this.fetchRows)
      return Promise.resolve([]);
    const existing = this.entries.get(pageIndex);
    if (existing) {
      existing.lastUsed = ++this.clock;
      return existing.promise || Promise.resolve(existing.rows || []);
    }
    while (this.entries.size >= MAX_CACHED_PAGES) this.evictOne(pageIndex);

    const offset = pageIndex * this.pageSize;
    if (offset >= this.rowCount) return Promise.resolve([]);
    const limit = Math.min(this.pageSize, this.rowCount - offset);
    const controller = new AbortController();
    const generation = this.generation;
    const entry = {
      status: "loading",
      rows: null,
      error: null,
      controller,
      lastUsed: ++this.clock,
      promise: null,
    };
    this.entries.set(pageIndex, entry);
    this.onDidChange?.();

    entry.promise = Promise.resolve()
      .then(() =>
        this.fetchRows({ offset, limit, pageIndex, signal: controller.signal }),
      )
      .then((result) => {
        const current = this.entries.get(pageIndex);
        if (
          this.destroyed ||
          generation !== this.generation ||
          current !== entry
        )
          return [];
        const rows = Array.isArray(result) ? result : result?.rows;
        if (!Array.isArray(rows))
          throw new TypeError(
            "fetchRows must resolve to an array or {rows: array}",
          );
        entry.status = "loaded";
        entry.rows = rows.slice(0, limit);
        entry.promise = null;
        entry.controller = null;
        this.onDidChange?.();
        return entry.rows;
      })
      .catch((error) => {
        const current = this.entries.get(pageIndex);
        if (
          this.destroyed ||
          generation !== this.generation ||
          current !== entry
        )
          return [];
        if (isAbortError(error) || controller.signal.aborted) {
          this.entries.delete(pageIndex);
          this.onDidChange?.();
          return [];
        }
        entry.status = "error";
        entry.rows = [];
        entry.error = error;
        entry.promise = null;
        entry.controller = null;
        this.onDidError?.(error, { offset, limit, pageIndex });
        this.onDidChange?.();
        return [];
      });
    return entry.promise;
  }

  async row(rowIndex) {
    if (rowIndex < 0 || rowIndex >= this.rowCount) return undefined;
    const pageIndex = this.pageForRow(rowIndex);
    await this.loadPage(pageIndex);
    const state = this.stateForRow(rowIndex);
    if (state.status === "error") throw state.error;
    return state.row;
  }

  whenIdle() {
    const promises = [];
    for (const entry of this.entries.values()) {
      if (entry.promise) promises.push(entry.promise);
    }
    return Promise.all(promises);
  }
}

module.exports = PagedRowCache;
