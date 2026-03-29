// Default values for all display toggles
const TOGGLE_DEFAULTS = {
  showStatusTags: true,
  showReviewers: true,
  showDates: true,
  showDeployments: true,
  showFilterBar: true,
};

// Open settings page
function openSettings() {
  browser.runtime.openOptionsPage();
  window.close();
}
document.getElementById('openSettings').addEventListener('click', openSettings);
document.getElementById('openSettings2').addEventListener('click', (e) => {
  e.preventDefault();
  openSettings();
});

// ── Context: detect current tab's owner/repo/token ───────────────
async function loadContext() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const match = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls/);

  const notPrEl = document.getElementById('notPrPage');
  const prCtxEl = document.getElementById('prPageContext');

  if (!match) {
    notPrEl.style.display = '';
    prCtxEl.style.display = 'none';
    return;
  }

  const owner = match[1];
  const repo = match[2];

  notPrEl.style.display = 'none';
  prCtxEl.style.display = '';

  document.getElementById('ctxOwner').textContent = owner;
  document.getElementById('ctxRepo').textContent = repo;

  // Resolve which token is active for this owner
  const { githubToken, ownerTokens } = await browser.storage.sync.get(['githubToken', 'ownerTokens']);
  const ownerToken = ownerTokens?.[owner];
  const tokenEl = document.getElementById('ctxToken');

  if (ownerToken) {
    tokenEl.textContent = `Owner-specific (…${ownerToken.slice(-4)})`;
    tokenEl.className = 'badge badge-green';
  } else if (githubToken) {
    tokenEl.textContent = `Default (…${githubToken.slice(-4)})`;
    tokenEl.className = 'badge badge-blue';
  } else {
    tokenEl.textContent = 'No token — API calls unauthenticated';
    tokenEl.className = 'badge badge-orange';
  }
}

// ── Toggles ──────────────────────────────────────────────────────
async function loadToggles() {
  const stored = await browser.storage.sync.get(['displayToggles']);
  const toggles = { ...TOGGLE_DEFAULTS, ...(stored.displayToggles || {}) };

  for (const checkbox of document.querySelectorAll('[data-key]')) {
    checkbox.checked = toggles[checkbox.dataset.key] ?? true;
  }
}

async function saveToggles() {
  const toggles = {};
  for (const checkbox of document.querySelectorAll('[data-key]')) {
    toggles[checkbox.dataset.key] = checkbox.checked;
  }
  await browser.storage.sync.set({ displayToggles: toggles });
}

// Save on every change immediately
for (const checkbox of document.querySelectorAll('[data-key]')) {
  checkbox.addEventListener('change', saveToggles);
}

// ── Init ─────────────────────────────────────────────────────────
loadContext();
loadToggles();
