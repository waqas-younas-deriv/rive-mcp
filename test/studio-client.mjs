const tokens = new Map();
export function rememberStudio(url) {
  const parsed = new URL(url);
  tokens.set(parsed.port, parsed.hash.slice(1));
}
export function studioFetch(input, options = {}) {
  const url = new URL(input);
  url.hostname = '127.0.0.1';
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${tokens.get(url.port)}` },
  });
}
export function studioToken(port) { return tokens.get(String(port)); }
