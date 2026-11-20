// Runs in the page before Docmore loads: web Notifications become native
// ones, the unread count reaches the dock badge, and the server picker can
// save the address. Nothing else from Node reaches the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('docmoreDesktop', {
  version: '0.1.0',
  setServer: (url) => ipcRenderer.invoke('docmore:set-server', url),
  setBadge: (count) => ipcRenderer.send('docmore:badge', Number(count) || 0),
});

// The web app calls new Notification(...) like in a browser; here it goes
// through the OS so it shows with the app's name and survives the window
// being hidden.
window.addEventListener('DOMContentLoaded', () => {
  const script = document.createElement('script');
  script.textContent = `
    (() => {
      const Native = window.Notification;
      class DesktopNotification extends EventTarget {
        constructor(title, options = {}) {
          super();
          this.title = title; this.body = options.body || ''; this.data = options.data;
          window.postMessage({ __docmoreNotify: { title, body: this.body, url: options.data && options.data.url } }, '*');
        }
        static requestPermission() { return Promise.resolve('granted'); }
        static get permission() { return 'granted'; }
        close() {}
      }
      window.Notification = DesktopNotification;
      // Unread badge from the title "(3) Docmore" pattern, if the app sets it.
      const observer = new MutationObserver(() => {
        const m = /^\\((\\d+)\\)/.exec(document.title || '');
        window.postMessage({ __docmoreBadge: m ? Number(m[1]) : 0 }, '*');
      });
      const titleEl = document.querySelector('title');
      if (titleEl) observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    })();
  `;
  document.documentElement.appendChild(script);
  script.remove();
});

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data) return;
  if (event.data.__docmoreNotify) ipcRenderer.send('docmore:notify', event.data.__docmoreNotify);
  if (typeof event.data.__docmoreBadge === 'number') ipcRenderer.send('docmore:badge', event.data.__docmoreBadge);
});
