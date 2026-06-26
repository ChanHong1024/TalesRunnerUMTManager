import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getSettings,
  installMap,
  loadCatalog,
  mergeStatuses,
  saveSettings,
  scanInstalledMaps,
  uninstallMap,
  deactivateMap,
  activateMap,
  DATA_SOURCES,
  findSourceByCsvUrl,
} from "../lib/tauriCommands";
import type { InstallStatus, MapWithStatus, Settings } from "../lib/types";

type StatusFilter = "all" | "installed" | "notInstalled";

/** CSV column indices (0-based) — stable across different sources */
const COL = {
  DB_ID: 0,
  MAP_ID: 1,
  DISPLAY_NAME: 2,
  DOWNLOAD: 3,
  ORIG_EN: 4,
  ORIG_CN: 5,
  ORIG_KR: 6,
  THUMB: 7,
  IMG1: 8,
  IMG2: 9,
  IMG3: 10,
  IMG4: 11,
  IMG5: 12,
  CREATOR_ID: 13,
  CREATOR: 14,
  SERVER: 15,
  CREATOR_YT: 16,
  MAP_COUNT: 17,
  CATEGORY: 18,
  FORUM_LINK: 19,
  YT_LINK: 20,
  INTRO: 21,
  NOTES: 22,
  MUST_PLAY: 23,
  RATING: 24,
  DIFFICULTY: 25,
  EQUIPMENT: 26,
  EXTREME_TIME: 27,
  NORMAL_TIME: 28,
  TESTER_PLAYED: 29,
  TESTER_DONE: 30,
  LAST_MODIFIED: 31,
} as const;

/** Image column indices */
const IMAGE_INDICES: Set<number> = new Set([COL.THUMB, COL.IMG1, COL.IMG2, COL.IMG3, COL.IMG4, COL.IMG5]);

/** Detail panel display order (by column index) — excludes images since they go in slideshow */
const DETAIL_INDICES: number[] = [
  COL.SERVER,
  COL.DISPLAY_NAME,
  COL.CREATOR,
  COL.CATEGORY,
  COL.RATING,
  COL.DIFFICULTY,
  COL.EQUIPMENT,
  COL.INTRO,
  COL.NOTES,
  COL.MUST_PLAY,
  COL.EXTREME_TIME,
  COL.NORMAL_TIME,
  COL.MAP_COUNT,
  COL.LAST_MODIFIED,
  COL.TESTER_PLAYED,
  COL.TESTER_DONE,
  COL.FORUM_LINK,
  COL.YT_LINK,
  COL.CREATOR_YT,
  COL.CREATOR_ID,
  COL.ORIG_EN,
  COL.ORIG_CN,
  COL.ORIG_KR,
];

function googleDriveImageUrl(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match) return `https://drive.usercontent.google.com/download?id=${match[1]}&export=view`;
  if (url.startsWith("http")) return url;
  return null;
}

function isImageUrl(value: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(value.trim())
    || /drive\.google\.com/.test(value)
    || /lh3\.google\.com/.test(value)
    || /drive\.usercontent\.google\.com/.test(value);
}

/** Get value from rawColumns by column index */
function colValue(rawColumns: [string, string][], index: number): string {
  return rawColumns[index]?.[1] ?? "";
}

/** Get header name from rawColumns by column index */
function colName(rawColumns: [string, string][], index: number): string {
  return rawColumns[index]?.[0] ?? "";
}

function youtubeVideoId(url: string): string | null {
  const match = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) || url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) || url.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

export default function App() {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [maps, setMaps] = useState<MapWithStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);

  const selected = maps.find((map) => map.id === selectedId) ?? null;

  // Build slideshow slides: YouTube first, then images
  const slides = useMemo(() => {
    if (!selected) return [];
    const items: { type: "image"; src: string }[] = [];
    // YouTube video first
    const ytUrl = colValue(selected.rawColumns, COL.YT_LINK);
    if (ytUrl) {
      const id = youtubeVideoId(ytUrl);
      if (id) items.push({ type: "image", src: `youtube:${id}` } as any);
    }
    // Thumbnail
    const thumbVal = colValue(selected.rawColumns, COL.THUMB);
    if (thumbVal) {
      const url = googleDriveImageUrl(thumbVal);
      if (url && isImageUrl(thumbVal)) items.push({ type: "image", src: url });
    }
    // Image columns 1-5
    for (const colIdx of [COL.IMG1, COL.IMG2, COL.IMG3, COL.IMG4, COL.IMG5]) {
      const val = colValue(selected.rawColumns, colIdx);
      if (val && isImageUrl(val)) {
        const url = googleDriveImageUrl(val);
        if (url) items.push({ type: "image", src: url });
      }
    }
    return items;
  }, [selected]);

  // Reset slide when map changes
  useEffect(() => { setSlideIndex(0); }, [selectedId]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [catalog, installed] = await Promise.all([loadCatalog(), scanInstalledMaps()]);
      const nextMaps = mergeStatuses(catalog, installed);
      setMaps(nextMaps);
      setSelectedId((current) => current ?? nextMaps[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.generic"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    getSettings()
      .then((nextSettings) => {
        setSettings(nextSettings);
        i18n.changeLanguage(nextSettings.language);
      })
      .catch(() => setError(t("error.generic")))
      .finally(refresh);
  }, []);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return maps.filter((map) => {
      const statusMatch =
        filter === "all" ||
        (filter === "installed" && map.status !== "notInstalled") ||
        (filter === "notInstalled" && map.status === "notInstalled");

      if (!statusMatch) return false;
      if (!normalizedQuery) return true;

      const haystack = [
        map.name,
        map.downloadUrl,
        ...map.rawColumns.map(([, v]) => v),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [filter, maps, query]);

  async function handleInstall(map: MapWithStatus) {
    setError(null);
    try {
      await installMap(map);
      await refresh();
      setSelectedId(map.id);
    } catch (err: any) {
      setError(err?.message ?? err?.toString?.() ?? JSON.stringify(err));
    }
  }

  async function handleDeactivate(map: MapWithStatus) {
    setError(null);
    try {
      await deactivateMap(map.id, map.installedFile);
      await refresh();
      setSelectedId(map.id);
    } catch (err: any) {
      setError(err?.message ?? err?.toString?.() ?? JSON.stringify(err));
    }
  }

  async function handleActivate(map: MapWithStatus) {
    setError(null);
    try {
      await activateMap(map.id);
      await refresh();
      setSelectedId(map.id);
    } catch (err: any) {
      setError(err?.message ?? err?.toString?.() ?? JSON.stringify(err));
    }
  }

  async function handleUninstall(map: MapWithStatus) {
    setError(null);
    try {
      await uninstallMap(map.id, map.installedFile);
      await refresh();
      setSelectedId(map.id);
    } catch (err: any) {
      setError(err?.message ?? err?.toString?.() ?? JSON.stringify(err));
    }
  }

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === filtered.length) return new Set();
      return new Set(filtered.map((m) => m.id));
    });
  }, [filtered]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Determine which bulk actions are relevant for the current selection
  const bulkSelection = useMemo(
    () => filtered.filter((m) => selectedIds.has(m.id)),
    [filtered, selectedIds],
  );
  const canBulkInstall = bulkSelection.some((m) => m.status === "notInstalled");
  const canBulkUninstall = bulkSelection.some((m) => m.status !== "notInstalled");
  const canBulkActivate = bulkSelection.some((m) => m.status === "deactivated");
  const canBulkDeactivate = bulkSelection.some((m) => m.status === "installedManaged" || m.status === "installedDetected");

  async function runBulk(
    action: "install" | "uninstall" | "activate" | "deactivate",
  ) {
    const targets = bulkSelection.filter((m) => {
      switch (action) {
        case "install": return m.status === "notInstalled";
        case "uninstall": return m.status !== "notInstalled";
        case "activate": return m.status === "deactivated";
        case "deactivate": return m.status === "installedManaged" || m.status === "installedDetected";
      }
    });
    if (targets.length === 0) return;

    setBulkRunning(true);
    setBulkProgress({ done: 0, total: targets.length });
    setError(null);

    const errors: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const map = targets[i];
      try {
        switch (action) {
          case "install": await installMap(map); break;
          case "uninstall": await uninstallMap(map.id, map.installedFile); break;
          case "activate": await activateMap(map.id); break;
          case "deactivate": await deactivateMap(map.id, map.installedFile); break;
        }
      } catch (err: any) {
        errors.push(`${map.name}: ${err?.message ?? err?.toString?.() ?? "unknown"}`);
      }
      setBulkProgress({ done: i + 1, total: targets.length });
    }

    await refresh();
    setSelectedIds(new Set());
    setBulkRunning(false);
    setBulkProgress(null);
    if (errors.length > 0) {
      setError(errors.join("\n"));
    }
  }

  async function handleSaveSettings(nextSettings: Settings) {
    const saved = await saveSettings(nextSettings);
    setSettings(saved);
    i18n.changeLanguage(saved.language);
    setSettingsOpen(false);
    await refresh();
  }

  // Get all available columns from the maps
  const allColumns = useMemo(() => {
    const cols = new Set<string>();
    for (const map of maps) {
      for (const [key] of map.rawColumns) {
        cols.add(key);
      }
    }
    return Array.from(cols);
  }, [maps]);

  const visibleColumns = settings?.visibleColumns?.length
    ? settings.visibleColumns.filter((c) => allColumns.includes(c))
    : ["顯示名稱"];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>{t("app.title")}</h1>
          <p>{settings?.installDir || "Documents\\跑Online\\UMT"}</p>
        </div>
        <div className="topbar-actions">
          <button className="button secondary" onClick={refresh}>
            {t("action.refresh")}
          </button>
          <button className="button primary" onClick={() => setSettingsOpen(true)}>
            {t("action.settings")}
          </button>
        </div>
      </header>

      <section className="toolbar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("search.placeholder")}
        />
        <div className="segmented">
          {(["all", "installed", "notInstalled"] as const).map((item) => (
            <button
              key={item}
              className={filter === item ? "active" : ""}
              onClick={() => setFilter(item)}
            >
              {t(`filter.${item}`)}
            </button>
          ))}
        </div>
      </section>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <section className="bulk-bar">
          <span className="bulk-count">{t("bulk.selected", { count: selectedIds.size })}</span>
          <div className="bulk-actions">
            {canBulkInstall && (
              <button className="button primary" disabled={bulkRunning} onClick={() => runBulk("install")}>
                {t("bulk.install")}
              </button>
            )}
            {canBulkDeactivate && (
              <button className="button secondary" disabled={bulkRunning} onClick={() => runBulk("deactivate")}>
                {t("bulk.deactivate")}
              </button>
            )}
            {canBulkActivate && (
              <button className="button primary" disabled={bulkRunning} onClick={() => runBulk("activate")}>
                {t("bulk.activate")}
              </button>
            )}
            {canBulkUninstall && (
              <button className="button danger" disabled={bulkRunning} onClick={() => runBulk("uninstall")}>
                {t("bulk.uninstall")}
              </button>
            )}
          </div>
          {bulkProgress && (
            <span className="bulk-progress">{bulkProgress.done} / {bulkProgress.total}</span>
          )}
          <button className="button secondary" onClick={clearSelection} disabled={bulkRunning}>
            {t("bulk.clear")}
          </button>
        </section>
      )}

      {error ? <div className="error" style={{ whiteSpace: "pre-line" }}>{error}</div> : null}

      <section className="content-grid">
        <div className="map-list">
          <div className="table-head" style={{ gridTemplateColumns: `36px repeat(${visibleColumns.length}, minmax(0, 1fr)) 100px 140px` }}>
            <span className="checkbox-cell">
              <input
                type="checkbox"
                checked={selectedIds.size > 0 && selectedIds.size === filtered.length}
                ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < filtered.length; }}
                onChange={toggleSelectAll}
              />
            </span>
            {visibleColumns.map((col) => (
              <span key={col}>{col}</span>
            ))}
            <span>{t("table.status")}</span>
            <span>{t("table.action")}</span>
          </div>

          {loading ? <div className="empty">{t("message.loading")}</div> : null}
          {!loading && filtered.length === 0 ? <div className="empty">{t("message.noResults")}</div> : null}

          {filtered.map((map) => (
            <button
              className={`map-row ${selectedId === map.id ? "selected" : ""}`}
              key={map.id}
              style={{ gridTemplateColumns: `36px repeat(${visibleColumns.length}, minmax(0, 1fr)) 100px 140px` }}
              onClick={() => setSelectedId(map.id)}
            >
              <span className="checkbox-cell" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(map.id)}
                  onChange={() => toggleSelect(map.id)}
                />
              </span>
              {visibleColumns.map((col) => {
                const value = map.rawColumns.find(([k]) => k === col)?.[1] ?? "-";
                return (
                  <span key={col} className="map-cell" title={value}>
                    {value}
                  </span>
                );
              })}
              <StatusBadge status={map.status} />
              <span className="row-action" onClick={(event) => event.stopPropagation()}>
                {(map.status === "installedManaged" || map.status === "installedDetected") ? (
                  <>
                    <button className="button secondary" onClick={() => handleDeactivate(map)}>
                      {t("action.deactivate")}
                    </button>
                    <button className="button danger" onClick={() => handleUninstall(map)}>
                      {t("action.uninstall")}
                    </button>
                  </>
                ) : map.status === "deactivated" ? (
                  <button className="button primary" onClick={() => handleActivate(map)}>
                    {t("action.activate")}
                  </button>
                ) : map.status === "notInstalled" ? (
                  <button className="button primary" onClick={() => handleInstall(map)}>
                    {t("action.install")}
                  </button>
                ) : null}
              </span>
            </button>
          ))}
        </div>

        <div className="right-column">
          {selected && slides.length > 0 && (
            <div className="slideshow-card">
              <div className="slideshow-container">
                {slides[slideIndex].src.startsWith("youtube:") ? (
                  <iframe
                    src={`https://www.youtube.com/embed/${slides[slideIndex].src.slice(8)}`}
                    style={{ width: "100%", aspectRatio: "16/9", border: "none", borderRadius: 8 }}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                ) : (
                  <img
                    src={slides[slideIndex].src}
                    alt={`slide ${slideIndex + 1}`}
                    onError={(e) => { (e.target as HTMLImageElement).src = "/default-preview.png"; }}
                    onClick={() => setLightboxUrl(slides[slideIndex].src)}
                  />
                )}
              </div>
              <div className="slideshow-controls">
                <button type="button" className="slide-btn" disabled={slideIndex === 0} onClick={() => setSlideIndex((i) => i - 1)}>◀</button>
                <span className="slide-counter">
                  {slides[slideIndex].src.startsWith("youtube:") ? "影片" : `${slideIndex + 1}/${slides.length}`}
                </span>
                <button type="button" className="slide-btn" disabled={slideIndex >= slides.length - 1} onClick={() => setSlideIndex((i) => i + 1)}>▶</button>
              </div>
              {slides.length > 1 && (
                <div className="slideshow-dots">
                  {slides.map((_, i) => (
                    <button key={i} type="button" className={`slide-dot ${i === slideIndex ? "active" : ""}`} onClick={() => setSlideIndex(i)} />
                  ))}
                </div>
              )}
            </div>
          )}

          <aside className="details-panel">
          <h2>{t("details.title")}</h2>
          {selected ? (
            <>
              <h3>{selected.name}</h3>
              <dl>
                <dt>{t("table.status")}</dt>
                <dd>
                  <StatusBadge status={selected.status} />
                </dd>
                <dt>{t("details.downloadUrl")}</dt>
                <dd className="break">{selected.downloadUrl}</dd>
                {selected.installedFile ? (
                  <>
                    <dt>{t("details.localFile")}</dt>
                    <dd>{selected.installedFile}</dd>
                  </>
                ) : null}
              </dl>

              {/* Ordered columns by index */}
              <div className="raw-data">
                {DETAIL_INDICES
                  .map((idx) => ({ idx, name: colName(selected.rawColumns, idx), value: colValue(selected.rawColumns, idx) }))
                  .filter(({ value }) => value !== "")
                  .map(({ idx, name, value }) => (
                    <div key={idx}>
                      <span>{name}</span>
                      <strong>{value || "-"}</strong>
                    </div>
                  ))}

                {/* Remaining columns not in DETAIL_INDICES or IMAGE_INDICES */}
                {selected.rawColumns
                  .filter((_, i) => !IMAGE_INDICES.has(i) && i !== COL.DB_ID && i !== COL.DOWNLOAD && !DETAIL_INDICES.includes(i))
                  .map(([name, value], i) => (
                    <div key={name + i}>
                      <span>{name}</span>
                      <strong>{value || "-"}</strong>
                    </div>
                  ))}
              </div>
            </>
          ) : (
            <p>{t("details.empty")}</p>
          )}
        </aside>
        </div>
      </section>

      {settingsOpen && settings ? (
        <SettingsDialog
          settings={settings}
          allColumns={allColumns}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
        />
      ) : null}

      <footer className="credits">
        <p>
          Developed by <strong>Porygon</strong>
        </p>
        <p>
          Map Craft 資料來源：
          <a href="https://docs.google.com/document/d/1A58tWn9h94VHtBmlC5YpmSG1ve42pg4zH4vHZghJiuk/edit?tab=t.0" target="_blank" rel="noopener noreferrer">
            幻紫OAO (WaanJiOAO)、puihong62871 及 TaiwanPro
          </a>
        </p>
        <p className="credits-disclaimer">
          本應用程式不擁有地圖資料庫。可於設定中更改資料來源。
        </p>
        <p>
          想新增地圖？
          <a href="https://docs.google.com/forms/d/e/1FAIpQLScLfPEDOoMfQj9bKD6E0JB-YNDS-HN2YCmUu323kz312acwFQ/viewform" target="_blank" rel="noopener noreferrer">
            填寫表單提交新地圖 →
          </a>
        </p>
      </footer>
      {lightboxUrl && (
        <div className="image-lightbox" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="預覽" />
        </div>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: InstallStatus }) {
  const { t } = useTranslation();
  return <span className={`status ${status}`}>{t(`status.${status}`)}</span>;
}

function SettingsDialog({
  settings,
  allColumns,
  onClose,
  onSave,
}: {
  settings: Settings;
  allColumns: string[];
  onClose: () => void;
  onSave: (settings: Settings) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);

  const visibleList = draft.visibleColumns || [];
  const visibleSet = new Set(visibleList);
  const hiddenCols = allColumns.filter((c) => !visibleSet.has(c));

  function toggleColumn(col: string) {
    if (visibleSet.has(col)) {
      setDraft({ ...draft, visibleColumns: visibleList.filter((c) => c !== col) });
    } else {
      setDraft({ ...draft, visibleColumns: [...visibleList, col] });
    }
  }

  function moveColumn(index: number, direction: -1 | 1) {
    const newList = [...visibleList];
    const target = index + direction;
    if (target < 0 || target >= newList.length) return;
    [newList[index], newList[target]] = [newList[target], newList[index]];
    setDraft({ ...draft, visibleColumns: newList });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="settings-modal" onSubmit={submit}>
        <header>
          <h2>{t("settings.title")}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t("action.close")}>
            x
          </button>
        </header>
        <label>
          {t("settings.installDir")}
          <input
            value={draft.installDir}
            onChange={(event) => setDraft({ ...draft, installDir: event.target.value })}
            placeholder="Documents\\跑Online\\UMT"
          />
        </label>
        <label>
          {t("settings.dataSource")}
          <select
            value={findSourceByCsvUrl(draft.sheetCsvUrl)?.id ?? "custom"}
            onChange={(event) => {
              const src = DATA_SOURCES.find((s) => s.id === event.target.value);
              if (src) setDraft({ ...draft, sheetCsvUrl: src.csvUrl });
            }}
          >
            {DATA_SOURCES.map((src) => (
              <option key={src.id} value={src.id}>
                {t(src.label)}
              </option>
            ))}
            <option value="custom" disabled>{t("source.custom")}</option>
          </select>
        </label>
        <label>
          {t("settings.language")}
          <select
            value={draft.language}
            onChange={(event) => setDraft({ ...draft, language: event.target.value as Settings["language"] })}
          >
            <option value="en">English</option>
            <option value="zh_HK">繁體中文（香港）</option>
            <option value="zh_TW">繁體中文（台灣）</option>
            <option value="kr">한국어</option>
          </select>
        </label>
        <fieldset className="column-picker">
          <legend>顯示欄位 (Visible Columns)</legend>
          <div className="column-selected">
            {visibleList.map((col, i) => (
              <div key={col} className="column-ordered">
                <span className="col-name">{col}</span>
                <span className="col-arrows">
                  <button type="button" className="col-btn" disabled={i === 0} onClick={() => moveColumn(i, -1)}>▲</button>
                  <button type="button" className="col-btn" disabled={i === visibleList.length - 1} onClick={() => moveColumn(i, 1)}>▼</button>
                  <button type="button" className="col-btn remove" onClick={() => toggleColumn(col)}>✕</button>
                </span>
              </div>
            ))}
            {visibleList.length === 0 && <span className="column-empty">尚未選取欄位</span>}
          </div>
          {hiddenCols.length > 0 && (
            <>
              <div className="column-divider">可新增欄位</div>
              <div className="column-available">
                {hiddenCols.map((col) => (
                  <button type="button" key={col} className="column-add" onClick={() => toggleColumn(col)}>
                    + {col}
                  </button>
                ))}
              </div>
            </>
          )}
        </fieldset>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t("action.close")}
          </button>
          <button className="button primary" disabled={saving}>
            {t("action.save")}
          </button>
        </footer>
      </form>
    </div>
  );
}
