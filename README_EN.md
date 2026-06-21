# Tales Runner UMT Map Manager

<p align="center">
  <img src="screenshots/app-icon.png" width="128" alt="Tales Runner UMT Map Manager Icon">
</p>

A desktop application for managing player-created maps (UMT) for Tales Runner (跑 Online).


🌐 **Language**: [繁體中文](README.md) | [English](README_EN.md) | [한국어](README_KR.md)

## Features

- 📋 **Map Catalog** — Automatically loads map database from Google Sheets, displaying all available UMT maps
- 🔍 **Search & Filter** — Search maps by keyword, filter by installed/not installed status
- 📥 **One-Click Install** — Download `.upk` map files directly from Google Drive and install to your map folder
- 🔄 **Deactivate/Activate** — Deactivate maps (move to `_deactivated` folder) without deleting, reactivate anytime
- 🗑️ **Safe Remove** — Safely delete maps based on install records without affecting other files
- 📊 **Customizable Columns** — Freely choose and reorder table columns (Display Name, Map ID, Category, Creator, etc.)
- 🌐 **Multi-Language** — Supports English, Traditional Chinese (Hong Kong/Taiwan), 한국어

## Installation

Download the latest installer:

- **Windows**: `Tales Runner UMT Map Manager_x.x.x_x64-setup.exe` (NSIS) or `.msi`

## Usage

### 1. Launch the App

After installation, open the app and it will automatically load the map list from Google Sheets.

### 2. Browse Maps

- The left table displays all available maps, showing "Display Name" and "Map ID" columns by default
- Use the search box at the top to filter by keyword
- Use `All` / `Installed` / `Not Installed` buttons to filter by status
- Click a map to view details in the right panel

### 3. Install a Map

1. Find the map you want (status: "Not Installed")
2. Click the `Install` button
3. The app will automatically download the `.upk` file from Google Drive
4. After download, the file is copied to your map folder

### 4. Deactivate / Activate Maps

- **Deactivate**: Click `Deactivate` on an installed map — the file moves to a `_deactivated` subfolder (game won't load it)
- **Activate**: Click `Activate` on a deactivated map — the file moves back to the original location

### 5. Remove a Map

1. Find an installed or detected map
2. Click the `Uninstall` button
3. The app will safely delete the map file

### 6. Settings

Click the `Settings` button at the top right to adjust:

| Setting | Description |
|---------|-------------|
| **Install Folder** | Map file storage location, default: `Documents\跑Online\UMT` |
| **Google Sheets URL** | Map database source, default: official "Database for html" tab |
| **Language** | Interface language |
| **Visible Columns** | Choose which columns to display and their order (▲▼ reorder, ✕ remove, + add) |

### Map Status

| Status | Description | Actions |
|--------|-------------|---------|
| **Not Installed** | Map not yet installed | `Install` |
| **Installed** | Map installed by this app | `Deactivate` `Uninstall` |
| **Detected** | Map found in folder (not installed by this app) | `Deactivate` `Uninstall` |
| **Deactivated** | Map deactivated (file in `_deactivated` folder) | `Activate` |

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Rust (Tauri v2)
- **Data Source**: Google Sheets CSV Export
- **Download**: Google Drive direct download (streaming with progress)
- **Installer**: NSIS / MSI (Windows)

## Data Source

The map database is collaboratively built and maintained by:

- **幻紫OAO** (Read: 왕지OAO / หว่างจี๋OAO / WaanJiOAO)
- **puihong62871**
- **TaiwanPro**

App Developer: **Porygon**

> ⚠️ This app does not own the map database. Map data belongs to the above members and their respective creators.
> Users can change the data source in **Settings → Google Sheets URL**.

Source document: [Google Docs](https://docs.google.com/document/d/1A58tWn9h94VHtBmlC5YpmSG1ve42pg4zH4vHZghJiuk/edit?tab=t.0)

## Contributing

Contributions are welcome! Please follow this workflow:

1. Fork the repo
2. Create your branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'Add some feature'`
4. Push to the branch: `git push origin feature/your-feature`
5. Open a Pull Request

> ⚠️ **All PRs require approval before merging to the master branch.**

### Submit New Maps

Want to add maps to the database? Fill out this form:

👉 [Submit New Map](https://docs.google.com/forms/d/e/1FAIpQLScLfPEDOoMfQj9bKD6E0JB-YNDS-HN2YCmUu323kz312acwFQ/viewform)

## Development

```bash
# Install dependencies
npm install

# Development mode
npm run tauri dev

# Build Windows installer
npm run tauri build
```

## License

For personal and community use. Map data belongs to their respective creators.
