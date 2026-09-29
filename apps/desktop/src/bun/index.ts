import { ApplicationMenu, BrowserWindow } from "electrobun/main";
import { resolveServerUrl } from "./server-url";

export const serverUrl = resolveServerUrl(Bun.env.ASTRYX_SERVER_URL);

ApplicationMenu.setApplicationMenu([
  { label: "File", submenu: [{ role: "close" }, { role: "quit" }] },
  { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
]);

new BrowserWindow({
  title: "Astryx Workspace",
  url: serverUrl,
  frame: { width: 1440, height: 960 },
  spellCheck: true,
  sandbox: true,
});
