// Grabs the page (or the selection) from the active tab and posts it to Docmore.
const $ = (id) => document.getElementById(id);
const api = typeof browser !== 'undefined' ? browser : chrome;

function grab(mode) {
  const sel = window.getSelection();
  let html = '';
  if (mode === 'selection' && sel && sel.rangeCount && !sel.isCollapsed) {
    const box = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) box.appendChild(sel.getRangeAt(i).cloneContents());
    html = box.innerHTML;
  } else {
    const root = document.querySelector('article') || document.querySelector('main') || document.body;
    html = root ? root.innerHTML : '';
  }
  return { title: document.title, url: location.href, html: html.slice(0, 2_500_000) };
}

async function clip(mode) {
  const cfg = await api.storage.sync.get(['server', 'apiKey', 'spaceId']);
  if (!cfg.server || !cfg.apiKey || !cfg.spaceId) {
    $('status').textContent = 'Set the server, API key and space in Options first.';
    return;
  }
  $('status').textContent = 'Clipping…';
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: grab, args: [mode] });
    if (mode === 'selection' && !result.html) {
      $('status').textContent = 'Nothing selected.';
      return;
    }
    const res = await fetch(cfg.server + '/api/clipper/clip', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ spaceId: cfg.spaceId, url: result.url, title: result.title, html: result.html }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const page = json.data || json;
    const slug = (page.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const url = cfg.server + '/s/' + page.spaceSlug + '/p/' + slug + '-' + page.slugId;
    $('status').innerHTML = 'Saved. <a href="' + url + '" target="_blank">Open the page</a>';
  } catch (err) {
    $('status').textContent = 'Failed: ' + err.message;
  }
}

$('page').addEventListener('click', () => clip('page'));
$('selection').addEventListener('click', () => clip('selection'));
$('options').addEventListener('click', (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});
