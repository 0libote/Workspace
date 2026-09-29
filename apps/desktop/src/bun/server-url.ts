export function resolveServerUrl(value: string | undefined): string {
  const candidate = value?.trim() || "http://127.0.0.1:3417";
  let url: URL;
  try { url = new URL(candidate); }
  catch { throw new RangeError("ASTRYX_SERVER_URL must be an absolute HTTP or HTTPS URL."); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new RangeError("ASTRYX_SERVER_URL must be an HTTP or HTTPS origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}
