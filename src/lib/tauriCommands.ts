import { invoke } from "@tauri-apps/api/core";
import type { InstalledMap, MapRecord, MapWithStatus, Settings } from "./types";

const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1z_-X1XgfZ8sgXkeSk_d_vjMNXVV_YAeNvnAk1naRmeA/export?format=csv&gid=2076954312";

export type DataSource = {
  id: string;
  label: string;
  csvUrl: string;
};

export const DATA_SOURCES: DataSource[] = [
  {
    id: "community",
    label: "source.community",
    csvUrl: DEFAULT_SHEET_URL,
  },
  {
    id: "porygon",
    label: "source.porygon",
    csvUrl: "https://docs.google.com/spreadsheets/d/1vbLJBswLlxFqPujV4ifu0Y0HelGzINEEqKBWlYplEe0/export?format=csv&gid=2076954312",
  },
];

export function findSourceByCsvUrl(url: string): DataSource | undefined {
  return DATA_SOURCES.find((s) => s.csvUrl === url);
}

const isTauri = () => "__TAURI_INTERNALS__" in window;

const fallbackSettings: Settings = {
  language: "zh_HK",
  installDir: "",
  sheetCsvUrl: DEFAULT_SHEET_URL,
  visibleColumns: ["顯示名稱", "地圖ID"],
};

const fallbackMaps: MapWithStatus[] = [
  {
    id: "demo-1",
    rowIndex: 1,
    name: "Demo Map",
    downloadUrl: "https://drive.google.com/file/d/example/view",
    rawColumns: [
      ["Column A", "Demo Map"],
      ["Column D", "https://drive.google.com/file/d/example/view"],
    ],
    status: "notInstalled",
  },
];

export async function getSettings(): Promise<Settings> {
  if (!isTauri()) return fallbackSettings;
  return invoke<Settings>("get_settings");
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  if (!isTauri()) {
    Object.assign(fallbackSettings, settings);
    return fallbackSettings;
  }
  return invoke<Settings>("save_settings", { settings });
}

export async function loadCatalog(): Promise<MapRecord[]> {
  if (!isTauri()) return fallbackMaps;
  return invoke<MapRecord[]>("load_catalog");
}

export async function scanInstalledMaps(): Promise<InstalledMap[]> {
  if (!isTauri()) return [];
  return invoke<InstalledMap[]>("scan_installed_maps");
}

export async function installMap(map: MapRecord): Promise<InstalledMap> {
  if (!isTauri()) {
    return {
      id: map.id,
      name: map.name,
      sourceUrl: map.downloadUrl,
      installedAt: new Date().toISOString(),
      installRoot: "",
      files: [`${map.name}.upk`],
      deactivated: false,
    };
  }
  return invoke<InstalledMap>("install_map", { map });
}

export async function uninstallMap(mapId: string, fileName?: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("uninstall_map", { mapId, fileName: fileName || null });
}

export async function deactivateMap(mapId: string, fileName?: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("deactivate_map", { mapId, fileName: fileName || null });
}

export async function activateMap(mapId: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("activate_map", { mapId });
}

export function mergeStatuses(catalog: MapRecord[], installed: InstalledMap[]): MapWithStatus[] {
  const byId = new Map(installed.map((item) => [item.id, item]));
  const detectedNames = new Map(
    installed
      .filter((item) => !item.sourceUrl)
      .flatMap((item) =>
        [item.name, ...item.files.map((file) => file.replace(/\.upk$/i, ""))]
          .filter(Boolean)
          .map((name) => [normalizeName(name), item] as const),
      ),
  );

  return catalog.map((map) => {
    const managed = byId.get(map.id);
    if (managed) {
      return {
        ...map,
        status: managed.deactivated ? "deactivated" : "installedManaged",
        installedFile: managed.files[0],
      };
    }

    const detected = detectedNames.get(normalizeName(map.name));
    if (detected) {
      return {
        ...map,
        status: detected.deactivated ? "deactivated" : "installedDetected",
        installedFile: detected.files[0],
      };
    }

    return {
      ...map,
      status: "notInstalled",
    };
  });
}

function normalizeName(value: string) {
  return value.trim().replace(/\.upk$/i, "").toLowerCase();
}
