// Stores the server, the API key and the default space.
const $ = (id) => document.getElementById(id);
const api = typeof browser !== 'undefined' ? browser : chrome;

async function load() {
  const cfg = await api.storage.sync.get(['server', 'apiKey', 'spaceId']);
  $('server').value = cfg.server || '';
  $('apiKey').value = cfg.apiKey || '';
  if (cfg.server && cfg.apiKey) await loadSpaces(cfg.spaceId);
}

async function loadSpaces(selected) {
  const server = $('server').value.trim().replace(/\/+$/, '');
  const apiKey = $('apiKey').value.trim();
  if (!server || !apiKey) return;
  $('status').textContent = 'Loading…';
  try {
    const res = await fetch(server + '/api/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ limit: 100 }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const items = (json.data && json.data.items) || json.items || [];
    $('space').innerHTML = items.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
    if (selected) $('space').value = selected;
    $('status').textContent = items.length + ' spaces';
  } catch (err) {
    $('status').textContent = 'Could not load spaces: ' + err.message;
  }
}

$('test').addEventListener('click', () => loadSpaces());
$('save').addEventListener('click', async () => {
  await api.storage.sync.set({
    server: $('server').value.trim().replace(/\/+$/, ''),
    apiKey: $('apiKey').value.trim(),
    spaceId: $('space').value,
  });
  $('status').textContent = 'Saved';
});
load();
