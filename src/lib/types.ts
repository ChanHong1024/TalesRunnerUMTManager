export type Language = "en" | "zh_HK" | "zh_TW" | "kr";

export type Settings = {
  language: Language;
  installDir: string;
  sheetCsvUrl: string;
  visibleColumns: string[];
};

export type MapRecord = {
  id: string;
  rowIndex: number;
  name: string;
  downloadUrl: string;
  rawColumns: [string, string][];
};

export type InstallStatus = "installedManaged" | "installedDetected" | "deactivated" | "notInstalled";

export type MapWithStatus = MapRecord & {
  status: InstallStatus;
  installedFile?: string;
};

export type InstalledMap = {
  id: string;
  name: string;
  sourceUrl: string;
  installedAt: string;
  installRoot: string;
  files: string[];
  deactivated: boolean;
};
