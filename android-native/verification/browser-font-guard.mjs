// Test-only network setting: an unreachable Google Fonts host otherwise keeps
// the unchanged browser suite's document.readyState wait open past its deadline.
// Does not intercept Firebase, APIs, application code or local styles/assets.
const seen = new Set(), sockets = new Set();
const end = Date.now() + 12 * 60_000;
const ports = [9333, 9334, 9335, 9336, 9337, 9338, 9340];
async function probe(port) {
  try {
    const pages = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(200) }).then(r => r.json());
    for (const page of pages.filter(p => p.type === 'page')) {
      if (seen.has(page.webSocketDebuggerUrl)) continue;
      seen.add(page.webSocketDebuggerUrl);
      const ws = new WebSocket(page.webSocketDebuggerUrl); sockets.add(ws);
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
        ws.send(JSON.stringify({ id: 2, method: 'Network.setBlockedURLs', params: { urls: ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'] } }));
        // Cancel an already pending stylesheet before tests begin interacting.
        if (page.url.startsWith('http://127.0.0.1:5500')) ws.send(JSON.stringify({ id: 3, method: 'Page.reload', params: { ignoreCache: true } }));
        console.log(`Configured test font-host isolation on Chrome ${port}`);
      };
      ws.onerror = () => {}; ws.onclose = () => sockets.delete(ws);
    }
  } catch {}
}
while (Date.now() < end) { await Promise.all(ports.map(probe)); await new Promise(resolve => setTimeout(resolve, 100)); }
for (const ws of sockets) ws.close();
