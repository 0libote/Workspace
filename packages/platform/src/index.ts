export type PlatformKind = "web" | "desktop";

export interface PlatformEnvironment {
  readonly kind: PlatformKind;
  readonly online: boolean;
  readonly notificationsAvailable: boolean;
  readonly filePickerAvailable: boolean;
}

export interface OpenFileOptions {
  readonly accept?: readonly string[];
}

export interface OpenedFile {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Platform {
  getEnvironment(): PlatformEnvironment;
  openFile(options?: OpenFileOptions): Promise<OpenedFile | null>;
  saveFile(name: string, contents: BlobPart, mediaType: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  notify(title: string, body: string): Promise<"shown" | "permission_required" | "unavailable">;
}

export interface WebPlatformRuntime {
  readonly navigator: Pick<Navigator, "onLine">;
  readonly document: Document;
  readonly URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  readonly Blob: typeof Blob;
  readonly Notification?: typeof Notification;
  readonly window: Pick<Window, "open">;
  readonly setTimeout?: typeof setTimeout;
}

interface OpenFilePickerWindow extends Window {
  showOpenFilePicker?: (options?: { readonly types?: readonly { readonly description: string; readonly accept: Readonly<Record<string, readonly string[]>> }[]; readonly multiple?: boolean }) => Promise<readonly { getFile(): Promise<File> }[]>;
}

export function normalizeFileAccept(accept: readonly string[]): string[] {
  const values = accept.map((value) => value.trim().toLowerCase());
  if (values.some((value) => !(/^\.[a-z0-9]{1,12}$/.test(value) || /^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/.test(value)))) {
    throw new RangeError("File picker accept values must be extensions or MIME types.");
  }
  return [...new Set(values)];
}

function openedFile(file: File): OpenedFile {
  return { name: file.name, mediaType: file.type, size: file.size, text: () => file.text(), arrayBuffer: () => file.arrayBuffer() };
}

export function validateExternalUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RangeError("External links must be absolute URLs."); }
  if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "mailto:") {
    throw new RangeError("Only HTTP, HTTPS, and mailto links can be opened externally.");
  }
  return url.toString();
}

export function createWebPlatform(runtime: WebPlatformRuntime = globalThis as unknown as WebPlatformRuntime): Platform {
  return {
    getEnvironment() {
      return {
        kind: "web",
        online: runtime.navigator.onLine,
        notificationsAvailable: Boolean(runtime.Notification),
        filePickerAvailable: typeof (runtime.window as OpenFilePickerWindow).showOpenFilePicker === "function",
      };
    },
    async openFile(options = {}) {
      const accept = normalizeFileAccept(options.accept ?? []);
      const picker = (runtime.window as OpenFilePickerWindow).showOpenFilePicker;
      const extensions = accept.filter((value) => value.startsWith("."));
      if (picker && extensions.length > 0) {
        try {
          const [handle] = await picker({
            multiple: false,
            types: [{ description: "Supported files", accept: { "application/octet-stream": extensions } }],
          });
          if (!handle) return null;
          return openedFile(await handle.getFile());
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return null;
          throw error;
        }
      }
      return await new Promise<OpenedFile | null>((resolve) => {
        const input = runtime.document.createElement("input");
        input.type = "file";
        input.accept = accept.join(",");
        input.hidden = true;
        const cleanup = () => input.remove();
        input.addEventListener("change", () => { const file = input.files?.[0] ?? null; cleanup(); resolve(file ? openedFile(file) : null); }, { once: true });
        input.addEventListener("cancel", () => { cleanup(); resolve(null); }, { once: true });
        runtime.document.body.append(input);
        input.click();
      });
    },
    async saveFile(name, contents, mediaType) {
      const safeName = name.trim();
      if (!safeName || /[\\/\u0000-\u001f]/.test(safeName)) throw new RangeError("A download name must be a single file name.");
      const url = runtime.URL.createObjectURL(new runtime.Blob([contents], { type: mediaType }));
      const anchor = runtime.document.createElement("a");
      anchor.href = url;
      anchor.download = safeName;
      anchor.hidden = true;
      runtime.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      (runtime.setTimeout ?? setTimeout)(() => runtime.URL.revokeObjectURL(url), 30_000);
    },
    async openExternal(value) {
      const url = validateExternalUrl(value);
      runtime.window.open(url, "_blank", "noopener,noreferrer");
    },
    async notify(title, body) {
      const notification = runtime.Notification;
      if (!notification) return "unavailable";
      if (notification.permission !== "granted") return "permission_required";
      new notification(title, { body });
      return "shown";
    },
  };
}

let activePlatform: Platform | null = null;

export function getPlatform(): Platform {
  if (activePlatform) return activePlatform;
  const injected = (globalThis as typeof globalThis & { readonly __ASTRYX_PLATFORM__?: Platform }).__ASTRYX_PLATFORM__;
  activePlatform = injected ?? createWebPlatform();
  return activePlatform;
}

export function setPlatformForProcess(platform: Platform): void { activePlatform = platform; }
