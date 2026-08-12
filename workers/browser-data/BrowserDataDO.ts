import {
  DurableObjectBase,
  schemaRpc,
  type DurableObjectContext,
} from "@workspace/runtime/worker/kernel";
import { browserProductMethods } from "@vibestudio/service-schemas/browserData";
import {
  BROWSER_PRODUCT_SCHEMA,
  MAX_PAGE_FAVICON_BYTES,
  detectFaviconMimeType,
  isFaviconMimeType,
  type BrowserDownloadRecord,
  type ImportedBookmark,
  type ImportedHistoryEntry,
  type ImportedHistoryVisit,
  type ImportedSearchEngine,
  type ImportJobWrite,
  type PageFavicon,
  type RecordHistoryVisitRequest,
  type UpdateHistoryTitleRequest,
} from "@vibestudio/browser-data";

const BATCH_SIZE = 500;

interface ImportSourceMeta {
  sourceId: string;
}

interface HistoryVisitWrite {
  visitTime: number;
  transition: string;
  source: "vibestudio" | "import";
  importSourceId: string;
  panelId: string;
  title?: string;
  typed: boolean;
}

/**
 * Favicons cross RPC as base64 and live in SQLite as BLOBs. Raw typed arrays do
 * not survive JSON transport (they arrive as `{"0":137,…}` and inflate ~6x), so
 * the conversion happens here, at the storage boundary, in both directions.
 */
function decodeFaviconData(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeFaviconData(value: unknown): string | null {
  if (!value) return null;
  const bytes =
    value instanceof Uint8Array
      ? value
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : null;
  if (!bytes) return null;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeFaviconRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    image_data: encodeFaviconData(row["image_data"]),
  };
}

export class BrowserDataDO extends DurableObjectBase {
  static override rpcMethods = browserProductMethods;
  static override schemaVersion = 1;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected override rpcSchemaCodeSource(): string | null {
    return "extensions/browser-data";
  }

  protected createTables(): void {
    this.executeSchema(BROWSER_PRODUCT_SCHEMA);
  }

  protected override requiredTables(): readonly string[] {
    return [
      "page_favicons",
      "site_preferences",
      "bookmarks",
      "history",
      "history_visits",
      "search_engines",
      "import_jobs",
      "import_batches",
      "downloads",
    ];
  }

  @schemaRpc()
  upsertDownloadRecord(record: BrowserDownloadRecord): void {
    if (!record.id || !record.environmentKey || !record.hostId) {
      throw new Error("Download metadata identity is incomplete");
    }
    const url = new URL(record.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Download metadata URL must use HTTP(S)");
    }
    if (
      !["progressing", "paused", "completed", "cancelled", "interrupted"].includes(record.state)
    ) {
      throw new Error("Download metadata state is invalid");
    }
    this.sql.exec(
      `INSERT INTO downloads
        (id, environment_key, host_id, panel_id, origin, url, filename, save_path,
         received_bytes, total_bytes, state, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         received_bytes = excluded.received_bytes,
         total_bytes = excluded.total_bytes,
         state = excluded.state,
         updated_at = excluded.updated_at`,
      record.id,
      record.environmentKey,
      record.hostId,
      record.panelId ?? null,
      record.origin ?? null,
      url.href,
      record.filename,
      record.savePath,
      Math.max(0, record.receivedBytes),
      Math.max(0, record.totalBytes),
      record.state,
      record.startedAt,
      record.updatedAt
    );
  }

  @schemaRpc()
  listDownloadRecords(hostId: string): BrowserDownloadRecord[] {
    return this.sql
      .exec(`SELECT * FROM downloads WHERE host_id = ? ORDER BY updated_at DESC LIMIT 500`, hostId)
      .toArray()
      .map((row) => ({
        id: String(row["id"]),
        environmentKey: String(row["environment_key"]),
        hostId: String(row["host_id"]),
        ...(row["panel_id"] == null ? {} : { panelId: String(row["panel_id"]) }),
        ...(row["origin"] == null ? {} : { origin: String(row["origin"]) }),
        url: String(row["url"]),
        filename: String(row["filename"]),
        savePath: String(row["save_path"]),
        receivedBytes: Number(row["received_bytes"]),
        totalBytes: Number(row["total_bytes"]),
        state: String(row["state"]) as BrowserDownloadRecord["state"],
        startedAt: Number(row["started_at"]),
        updatedAt: Number(row["updated_at"]),
      }));
  }

  // -- Site preferences ----------------------------------------------------

  @schemaRpc()
  getSitePreferences(origin: string): { origin: string; zoomFactor: number; updatedAt?: number } {
    const normalized = this.requireHttpOrigin(origin);
    const row = this.sql
      .exec(`SELECT zoom_factor, updated_at FROM site_preferences WHERE origin = ?`, normalized)
      .toArray()[0];
    return {
      origin: normalized,
      zoomFactor: row ? Number(row["zoom_factor"]) : 1,
      ...(row ? { updatedAt: Number(row["updated_at"]) } : {}),
    };
  }

  @schemaRpc()
  setSiteZoom(origin: string, zoomFactor: number): void {
    const normalized = this.requireHttpOrigin(origin);
    if (!Number.isFinite(zoomFactor) || zoomFactor < 0.25 || zoomFactor > 5) {
      throw new Error("Browser zoom factor must be between 0.25 and 5");
    }
    this.sql.exec(
      `INSERT INTO site_preferences(origin, zoom_factor, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(origin) DO UPDATE SET
         zoom_factor = excluded.zoom_factor,
         updated_at = excluded.updated_at`,
      normalized,
      zoomFactor,
      Date.now()
    );
  }

  // -- Bookmarks -----------------------------------------------------------

  @schemaRpc()
  getBookmarks(folderPath = "/") {
    return this.sql
      .exec(`SELECT * FROM bookmarks WHERE folder_path = ? ORDER BY position, title`, folderPath)
      .toArray();
  }

  @schemaRpc()
  getAllBookmarks() {
    return this.sql.exec(`SELECT * FROM bookmarks ORDER BY folder_path, position, title`).toArray();
  }

  @schemaRpc()
  addBookmark(bookmark: {
    title: string;
    url?: string;
    folderPath?: string;
    dateAdded?: number;
    tags?: string;
    keyword?: string;
    position?: number;
  }): number {
    const result = this.sql
      .exec(
        `INSERT INTO bookmarks
          (title, url, folder_path, date_added, position, tags, keyword)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        bookmark.title,
        bookmark.url ?? null,
        bookmark.folderPath ?? "/",
        bookmark.dateAdded ?? Date.now(),
        bookmark.position ?? 0,
        bookmark.tags ?? null,
        bookmark.keyword ?? null
      )
      .one();
    return Number(result["id"]);
  }

  @schemaRpc()
  updateBookmark(id: number, partial: Record<string, unknown>): void {
    this.updateByMap(
      "bookmarks",
      id,
      {
        title: "title",
        url: "url",
        folderPath: "folder_path",
        tags: "tags",
        keyword: "keyword",
        position: "position",
      },
      partial,
      { date_modified: Date.now() }
    );
  }

  @schemaRpc()
  deleteBookmark(id: number): void {
    this.sql.exec(`DELETE FROM bookmarks WHERE id = ?`, id);
  }

  @schemaRpc()
  moveBookmark(id: number, folderPath: string, position: number): void {
    this.sql.exec(
      `UPDATE bookmarks SET folder_path = ?, position = ?, date_modified = ? WHERE id = ?`,
      folderPath,
      position,
      Date.now(),
      id
    );
  }

  @schemaRpc()
  searchBookmarks(query: string) {
    const pattern = `%${this.escapeLikePattern(query)}%`;
    return this.sql
      .exec(
        `SELECT * FROM bookmarks
         WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'
         ORDER BY date_modified DESC, date_added DESC LIMIT 100`,
        pattern,
        pattern
      )
      .toArray();
  }

  // -- History -------------------------------------------------------------

  @schemaRpc()
  getHistory(query: {
    search?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    offset?: number;
  }) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.search) {
      const pattern = `%${this.escapeLikePattern(query.search)}%`;
      clauses.push(`(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern);
    }
    if (query.startTime !== undefined) {
      clauses.push("last_visit >= ?");
      params.push(query.startTime);
    }
    if (query.endTime !== undefined) {
      clauses.push("last_visit <= ?");
      params.push(query.endTime);
    }
    params.push(Math.min(Math.max(query.limit ?? 100, 1), 1_000), Math.max(query.offset ?? 0, 0));
    return this.sql
      .exec(
        `SELECT * FROM history ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY last_visit DESC LIMIT ? OFFSET ?`,
        ...params
      )
      .toArray();
  }

  @schemaRpc()
  searchHistory(query: string, limit = 50) {
    return this.getHistory({ search: query, limit });
  }

  @schemaRpc()
  searchHistoryForAutocomplete(query: { query: string; limit?: number }) {
    return this.getHistory({ search: query.query, limit: query.limit ?? 20 });
  }

  @schemaRpc()
  recordHistoryVisit(request: RecordHistoryVisitRequest): number {
    const visitTime = request.visitTime ?? Date.now();
    const historyId = this.ensureHistoryRow(request.url, request.title, visitTime);
    this.insertHistoryVisit(historyId, {
      visitTime,
      transition: request.transition ?? "link",
      source: request.source ?? "vibestudio",
      importSourceId: "",
      panelId: request.panelId ?? "",
      title: request.title,
      typed: request.typed === true,
    });
    this.recomputeHistorySummary(historyId);
    return historyId;
  }

  @schemaRpc()
  updateHistoryTitle(request: UpdateHistoryTitleRequest): void {
    const title = request.title.trim();
    if (!title) return;
    this.sql.exec(`UPDATE history SET title = ? WHERE url = ?`, title, request.url);
    this.sql.exec(
      `UPDATE history_visits SET title = ? WHERE id = (
         SELECT history_visits.id
         FROM history_visits
         JOIN history ON history.id = history_visits.history_id
         WHERE history.url = ? AND history_visits.visit_time <= ?
         ORDER BY history_visits.visit_time DESC, history_visits.id DESC
         LIMIT 1
       )`,
      title,
      request.url,
      request.observedAt ?? Date.now()
    );
  }

  @schemaRpc()
  deleteHistoryEntry(id: number): void {
    this.sql.exec(`DELETE FROM history WHERE id = ?`, id);
  }

  @schemaRpc()
  deleteHistoryRange(start: number, end: number): number {
    const affected = this.sql
      .exec(
        `SELECT DISTINCT history_id AS id FROM history_visits
         WHERE visit_time >= ? AND visit_time <= ?`,
        start,
        end
      )
      .toArray()
      .map((row) => Number(row["id"]));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM history_visits WHERE visit_time >= ? AND visit_time <= ?`,
        start,
        end
      );
      for (const id of affected) {
        const count = Number(
          this.sql
            .exec(`SELECT COUNT(*) AS count FROM history_visits WHERE history_id = ?`, id)
            .one()["count"]
        );
        if (count === 0) this.sql.exec(`DELETE FROM history WHERE id = ?`, id);
        else this.recomputeHistorySummary(id);
      }
    });
    return affected.length;
  }

  @schemaRpc()
  clearAllHistory(): void {
    this.sql.exec(`DELETE FROM history_visits`);
    this.sql.exec(`DELETE FROM history`);
  }

  // -- Search engines and favicons -----------------------------------------

  @schemaRpc()
  getSearchEngines() {
    return this.sql.exec(`SELECT * FROM search_engines ORDER BY is_default DESC, name`).toArray();
  }

  @schemaRpc()
  setDefaultEngine(id: number): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE search_engines SET is_default = 0`);
      this.sql.exec(`UPDATE search_engines SET is_default = 1 WHERE id = ?`, id);
    });
  }

  @schemaRpc()
  putPageFavicon(favicon: PageFavicon): void {
    const page = new URL(favicon.pageUrl);
    const origin = new URL(favicon.origin);
    if (
      (page.protocol !== "http:" && page.protocol !== "https:") ||
      page.origin !== origin.origin
    ) {
      throw new Error("Favicon page association must use one matching HTTP(S) origin");
    }
    if (!isFaviconMimeType(favicon.mimeType)) {
      throw new Error(`Unsupported favicon MIME type: ${favicon.mimeType}`);
    }
    const imageData = decodeFaviconData(favicon.data);
    this.assertFaviconBytes(imageData);
    const detectedMimeType = detectFaviconMimeType(imageData);
    if (detectedMimeType !== favicon.mimeType) {
      throw new Error(
        `Favicon bytes are ${detectedMimeType ?? "not a supported image"}, not ${favicon.mimeType}`
      );
    }
    this.sql.exec(
      `INSERT INTO page_favicons
        (page_url, origin, source_url, image_data, mime_type, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(page_url) DO UPDATE SET
         origin = excluded.origin,
         source_url = excluded.source_url,
         image_data = excluded.image_data,
         mime_type = excluded.mime_type,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= page_favicons.updated_at`,
      page.href,
      origin.origin,
      favicon.sourceUrl ?? null,
      imageData,
      favicon.mimeType,
      favicon.updatedAt
    );
  }

  @schemaRpc()
  getPageFavicon(pageUrl: string) {
    const page = new URL(pageUrl);
    if (page.protocol !== "http:" && page.protocol !== "https:") return null;
    const exact = this.sql
      .exec(`SELECT * FROM page_favicons WHERE page_url = ?`, page.href)
      .toArray()[0];
    if (exact) return encodeFaviconRow(exact);
    const byOrigin = this.sql
      .exec(
        `SELECT * FROM page_favicons WHERE origin = ? ORDER BY updated_at DESC LIMIT 1`,
        page.origin
      )
      .toArray()[0];
    return byOrigin ? encodeFaviconRow(byOrigin) : null;
  }

  // -- Import storage ------------------------------------------------------

  @schemaRpc()
  upsertImportJob(job: ImportJobWrite): void {
    this.sql.exec(
      `INSERT INTO import_jobs
        (job_id, host_id, host_label, source_id, browser, phase, started_at, updated_at,
         finished_at, data_types, progress, warnings, error, resumable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         phase = excluded.phase,
         updated_at = excluded.updated_at,
         finished_at = excluded.finished_at,
         progress = excluded.progress,
         warnings = excluded.warnings,
         error = excluded.error,
         resumable = excluded.resumable`,
      job.jobId,
      job.hostId,
      job.hostLabel,
      job.sourceId,
      job.browser,
      job.phase,
      job.startedAt,
      job.updatedAt,
      job.finishedAt ?? null,
      JSON.stringify(job.dataTypes),
      JSON.stringify(job.progress),
      JSON.stringify(job.warnings),
      job.error ?? null,
      job.resumable ? 1 : 0
    );
  }

  @schemaRpc()
  getImportJob(jobId: string) {
    const row = this.sql.exec(`SELECT * FROM import_jobs WHERE job_id = ?`, jobId).toArray()[0];
    return row ? this.importJobRow(row) : null;
  }

  @schemaRpc()
  listImportJobs() {
    return this.sql
      .exec(`SELECT * FROM import_jobs ORDER BY updated_at DESC LIMIT 100`)
      .toArray()
      .map((row) => this.importJobRow(row));
  }

  @schemaRpc()
  recordImportBatch(input: {
    jobId: string;
    dataType: string;
    batchIndex: number;
    idempotencyKey: string;
    itemCount: number;
  }): { stored: boolean } {
    const existing = this.sql
      .exec(`SELECT 1 FROM import_batches WHERE idempotency_key = ?`, input.idempotencyKey)
      .toArray();
    if (existing.length > 0) return { stored: false };
    this.sql.exec(
      `INSERT INTO import_batches
        (job_id, data_type, batch_index, idempotency_key, item_count, stored_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.jobId,
      input.dataType,
      input.batchIndex,
      input.idempotencyKey,
      input.itemCount,
      Date.now()
    );
    return { stored: true };
  }

  @schemaRpc()
  async addBookmarksBatch(bookmarks: ImportedBookmark[], meta: ImportSourceMeta): Promise<number> {
    return this.runBatch(bookmarks.length, (index) => {
      const bookmark = bookmarks[index];
      if (!bookmark) throw new Error(`Bookmark batch item ${index} is unavailable`);
      const folderPath = `/${bookmark.folder.join("/")}`.replace(/\/+/g, "/");
      const importKey = this.importKey("bookmark", meta.sourceId, [
        bookmark.sourceId ?? "",
        bookmark.url,
        folderPath,
      ]);
      this.sql.exec(
        `INSERT INTO bookmarks
          (title, url, folder_path, date_added, date_modified, position, source_id, import_key,
           tags, keyword)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(import_key) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           folder_path = excluded.folder_path,
           date_modified = MAX(bookmarks.date_modified, excluded.date_modified),
           tags = excluded.tags,
           keyword = excluded.keyword`,
        bookmark.title,
        bookmark.url,
        folderPath,
        bookmark.dateAdded,
        bookmark.dateModified ?? bookmark.dateAdded,
        index,
        meta.sourceId,
        importKey,
        bookmark.tags?.join(",") ?? null,
        bookmark.keyword ?? null
      );
    });
  }

  @schemaRpc()
  async addHistoryBatch(entries: ImportedHistoryEntry[], meta: ImportSourceMeta): Promise<number> {
    return this.runBatch(entries.length, (index) => {
      const entry = entries[index];
      if (!entry) throw new Error(`History batch item ${index} is unavailable`);
      const visits = this.importedVisitsForEntry(entry);
      for (const visit of visits) {
        const historyId = this.ensureHistoryRow(entry.url, entry.title, visit.visitTime);
        this.insertHistoryVisit(historyId, {
          visitTime: visit.visitTime,
          transition: visit.transition ?? entry.transition ?? "link",
          source: "import",
          importSourceId: meta.sourceId,
          panelId: "",
          title: entry.title,
          typed: visit.typed ?? false,
        });
        this.recomputeHistorySummary(historyId);
      }
    });
  }

  @schemaRpc()
  async addSearchEnginesBatch(
    engines: ImportedSearchEngine[],
    meta: ImportSourceMeta
  ): Promise<number> {
    return this.runBatch(engines.length, (index) => {
      const engine = engines[index];
      if (!engine) throw new Error(`Search-engine batch item ${index} is unavailable`);
      const importKey = this.importKey("search-engine", meta.sourceId, [
        engine.sourceId ?? "",
        engine.searchUrl,
      ]);
      if (engine.isDefault) this.sql.exec(`UPDATE search_engines SET is_default = 0`);
      this.sql.exec(
        `INSERT INTO search_engines
          (name, keyword, search_url, suggest_url, favicon_url, is_default, source_id, import_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(import_key) DO UPDATE SET
           name = excluded.name,
           keyword = excluded.keyword,
           search_url = excluded.search_url,
           suggest_url = excluded.suggest_url,
           favicon_url = excluded.favicon_url,
           is_default = excluded.is_default`,
        engine.name,
        engine.keyword ?? null,
        engine.searchUrl,
        engine.suggestUrl ?? null,
        engine.faviconUrl ?? null,
        engine.isDefault ? 1 : 0,
        meta.sourceId,
        importKey
      );
    });
  }

  @schemaRpc()
  async addFaviconsBatch(favicons: PageFavicon[]): Promise<number> {
    return this.runBatch(favicons.length, (index) => {
      const favicon = favicons[index];
      if (!favicon) throw new Error(`Favicon batch item ${index} is unavailable`);
      return this.putPageFavicon(favicon);
    });
  }

  // -- Helpers -------------------------------------------------------------

  private ensureHistoryRow(url: string, title: string | undefined, observedAt: number): number {
    const row = this.sql
      .exec(
        `INSERT INTO history(url, title, visit_count, typed_count, first_visit, last_visit)
         VALUES (?, ?, 0, 0, NULL, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = CASE WHEN excluded.title IS NOT NULL AND excluded.title != ''
             THEN excluded.title ELSE history.title END,
           last_visit = MAX(history.last_visit, excluded.last_visit)
         RETURNING id`,
        url,
        title?.trim() || null,
        observedAt
      )
      .one();
    return Number(row["id"]);
  }

  private insertHistoryVisit(historyId: number, visit: HistoryVisitWrite): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO history_visits
        (history_id, visit_time, transition, source, import_source_id, panel_id, title, typed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      historyId,
      visit.visitTime,
      visit.transition,
      visit.source,
      visit.importSourceId,
      visit.panelId,
      visit.title ?? null,
      visit.typed ? 1 : 0
    );
  }

  private recomputeHistorySummary(historyId: number): void {
    this.sql.exec(
      `UPDATE history SET
         visit_count = (SELECT COUNT(*) FROM history_visits WHERE history_id = ?),
         typed_count = (SELECT COALESCE(SUM(typed), 0) FROM history_visits WHERE history_id = ?),
         first_visit = (SELECT MIN(visit_time) FROM history_visits WHERE history_id = ?),
         last_visit = (SELECT MAX(visit_time) FROM history_visits WHERE history_id = ?),
         title = COALESCE(
           (SELECT title FROM history_visits
            WHERE history_id = ? AND title IS NOT NULL AND title != ''
            ORDER BY visit_time DESC LIMIT 1),
           title
         )
       WHERE id = ?`,
      historyId,
      historyId,
      historyId,
      historyId,
      historyId,
      historyId
    );
  }

  private importedVisitsForEntry(entry: ImportedHistoryEntry): ImportedHistoryVisit[] {
    if (entry.visits?.length) {
      return entry.visits
        .filter((visit) => Number.isFinite(visit.visitTime) && visit.visitTime > 0)
        .sort((a, b) => a.visitTime - b.visitTime);
    }
    if (!Number.isFinite(entry.lastVisitTime) || entry.lastVisitTime <= 0) return [];
    const count = Math.max(1, entry.visitCount || 1);
    const first =
      entry.firstVisitTime && Number.isFinite(entry.firstVisitTime)
        ? Math.min(entry.firstVisitTime, entry.lastVisitTime)
        : entry.lastVisitTime;
    if (count === 1 || first === entry.lastVisitTime) {
      return [{ visitTime: entry.lastVisitTime, transition: entry.transition }];
    }
    const step = (entry.lastVisitTime - first) / (count - 1);
    return Array.from({ length: count }, (_, index) => ({
      visitTime: Math.round(first + step * index),
      transition: entry.transition,
      typed: index < (entry.typedCount ?? 0),
    }));
  }

  private importJobRow(row: Record<string, unknown>) {
    return {
      jobId: String(row["job_id"]),
      hostId: String(row["host_id"]),
      hostLabel: String(row["host_label"]),
      sourceId: String(row["source_id"]),
      browser: String(row["browser"]),
      phase: String(row["phase"]),
      startedAt: Number(row["started_at"]),
      updatedAt: Number(row["updated_at"]),
      ...(row["finished_at"] == null ? {} : { finishedAt: Number(row["finished_at"]) }),
      requestedDataTypes: this.parseStringArray(row["data_types"]),
      progress: this.parseJson(row["progress"], []),
      warnings: this.parseStringArray(row["warnings"]),
      ...(row["error"] == null ? {} : { error: String(row["error"]) }),
      resumable: Number(row["resumable"]) === 1,
    };
  }

  private httpOrigin(raw: string): string | null {
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
    } catch {
      return null;
    }
  }

  private requireHttpOrigin(raw: string): string {
    const origin = this.httpOrigin(raw);
    if (!origin) throw new Error("Origin must use HTTP(S)");
    return origin;
  }

  private parseStringArray(value: unknown): string[] {
    const parsed = this.parseJson<unknown>(value, []);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  }

  private parseJson<T>(value: unknown, fallback: T): T {
    if (typeof value !== "string") return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private assertFaviconBytes(value: Uint8Array | undefined): void {
    if (!value || value.byteLength === 0) {
      throw new Error("Favicon has no image data");
    }
    if (value.byteLength > MAX_PAGE_FAVICON_BYTES) {
      throw new Error(`Favicon exceeds ${MAX_PAGE_FAVICON_BYTES} bytes`);
    }
  }

  private importKey(kind: string, sourceId: string, parts: string[]): string {
    return [kind, sourceId, ...parts].join("\x00");
  }

  private updateByMap(
    table: string,
    id: number,
    map: Record<string, string>,
    partial: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(map)) {
      if (partial[field] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(partial[field]);
      }
    }
    for (const [column, value] of Object.entries(extra)) {
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.sql.exec(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`, ...values);
  }

  private async runBatch(total: number, apply: (index: number) => void): Promise<number> {
    for (let start = 0; start < total; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, total);
      this.ctx.storage.transactionSync(() => {
        for (let index = start; index < end; index += 1) apply(index);
      });
      if (end < total) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return total;
  }

  private escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
  }

  private executeSchema(
    schema: string,
    sql: { exec(query: string, ...bindings: unknown[]): unknown } = this.sql
  ): void {
    let buffer: string[] = [];
    let inTrigger = false;
    for (const line of schema.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("/**") || trimmed.startsWith("*")) continue;
      if (/^CREATE TRIGGER\b/i.test(trimmed)) inTrigger = true;
      buffer.push(line);
      if ((inTrigger && /^END;$/i.test(trimmed)) || (!inTrigger && trimmed.endsWith(";"))) {
        sql.exec(buffer.join("\n"));
        buffer = [];
        inTrigger = false;
      }
    }
    if (buffer.length > 0) sql.exec(buffer.join("\n"));
  }
}
