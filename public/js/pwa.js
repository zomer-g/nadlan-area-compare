// Installable app: registers the service worker (/sw.js) and offers a small
// "התקנה" button where the browser supports beforeinstallprompt (Chrome, Edge,
// Android). Nothing is shown on iOS / Safari: there the meta tags in
// index.html are all it takes, through Share → Add to Home Screen.

const DISMISS_KEY = 'nadlan-area-compare:install-dismissed';
const DISMISS_DAYS = 30;

if ('serviceWorker' in navigator) {
  // After load, so the first visit's precache does not compete with the page.
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('service worker:', e.message));
  });
}

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const dismissed = () => {
  try { return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < DISMISS_DAYS * 864e5; } catch { return false; }
};

let deferred = null;
let box = null;

function hide() {
  box?.remove();
  box = null;
}

function show() {
  if (box || standalone() || dismissed()) return;
  box = document.createElement('div');
  box.className = 'install';
  box.innerHTML = `<button type="button" class="small-btn install-go" title="התקנת האתר כאפליקציה במכשיר">⬇ התקנה</button>`
    + `<button type="button" class="install-x" aria-label="לא עכשיו" title="לא עכשיו">×</button>`;
  box.querySelector('.install-go').addEventListener('click', async () => {
    const e = deferred;
    deferred = null;
    hide();
    if (!e) return;
    e.prompt();
    const { outcome } = await e.userChoice;
    if (outcome === 'dismissed') try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ }
  });
  box.querySelector('.install-x').addEventListener('click', () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ }
    hide();
  });
  (document.querySelector('header.top .register') || document.body).prepend(box);
}

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // no mini-infobar: our own button instead
  deferred = e;
  show();
});
addEventListener('appinstalled', () => {
  deferred = null;
  hide();
});
