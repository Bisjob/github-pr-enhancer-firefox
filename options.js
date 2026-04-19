// Storage schema
// ───────────────────────────────────────────────────────────────
//  githubToken   : string  — default token (legacy key, kept for back-compat)
//  ownerTokens   : object  — { [ownerName: string]: string }  per-owner overrides
// ───────────────────────────────────────────────────────────────

const TOKEN_RE = /^github_pat_/;

function showStatus(type, message) {
  const el = document.getElementById('status');
  el.className = `status ${type}`;
  el.textContent = message;
  el.style.display = 'block';
  if (type === 'success') setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Toggle visibility ────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-visibility');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.target);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.textContent = input.type === 'password' ? '👁' : '🙈';
});

// ── Owner rows ───────────────────────────────────────────────────
function createOwnerRow(owner = '', token = '') {
  const row = document.createElement('div');
  row.className = 'owner-row';

  const ownerInput = document.createElement('input');
  ownerInput.type = 'text';
  ownerInput.placeholder = 'owner or org name';
  ownerInput.value = owner;
  ownerInput.autocomplete = 'off';
  ownerInput.spellcheck = false;

  const wrap = document.createElement('div');
  wrap.className = 'token-input-wrap';

  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.placeholder = 'github_pat_…';
  tokenInput.value = token;
  tokenInput.autocomplete = 'off';
  tokenInput.spellcheck = false;

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'toggle-visibility';
  toggleBtn.title = 'Show / hide token';
  toggleBtn.textContent = '👁';
  // use a unique id for the toggle target
  const uid = `ownerToken-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tokenInput.id = uid;
  toggleBtn.dataset.target = uid;

  wrap.appendChild(tokenInput);
  wrap.appendChild(toggleBtn);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-danger';
  removeBtn.title = 'Remove this entry';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => row.remove());

  row.appendChild(ownerInput);
  row.appendChild(wrap);
  row.appendChild(removeBtn);

  return row;
}

document.getElementById('addOwner').addEventListener('click', () => {
  document.getElementById('ownerRows').appendChild(createOwnerRow());
});

// ── Load saved settings ──────────────────────────────────────────
async function loadSettings() {
  try {
    const result = await browser.storage.sync.get(['githubToken', 'ownerTokens']);
    if (result.githubToken) {
      document.getElementById('defaultToken').value = result.githubToken;
    }

    const ownerTokens = result.ownerTokens || {};
    const container = document.getElementById('ownerRows');
    container.innerHTML = '';
    for (const [owner, token] of Object.entries(ownerTokens)) {
      container.appendChild(createOwnerRow(owner, token));
    }
  } catch (err) {
    console.error('[GitHub PR Enhancer] Failed to load settings:', err);
  }
}

// ── Save ─────────────────────────────────────────────────────────
document.getElementById('save').addEventListener('click', async () => {
  const defaultToken = document.getElementById('defaultToken').value.trim();

  // Validate default token (if provided)
  if (defaultToken && !TOKEN_RE.test(defaultToken)) {
    showStatus('error', 'Default token: invalid format. Must start with github_pat_');
    return;
  }

  // Collect and validate owner rows
  const ownerTokens = {};
  const rows = document.querySelectorAll('#ownerRows .owner-row');
  for (const row of rows) {
    const [ownerInput, wrap] = row.children;
    const tokenInput = wrap.querySelector('input');
    const owner = ownerInput.value.trim();
    const token = tokenInput.value.trim();

    if (!owner && !token) continue; // skip empty rows silently

    if (!owner) {
      showStatus('error', 'Each per-owner entry must have an owner name.');
      ownerInput.focus();
      return;
    }
    if (!token) {
      showStatus('error', `Token for "${owner}" is empty.`);
      tokenInput.focus();
      return;
    }
    if (!TOKEN_RE.test(token)) {
      showStatus('error', `Token for "${owner}": invalid format. Must start with github_pat_`);
      tokenInput.focus();
      return;
    }
    if (ownerTokens[owner]) {
      showStatus('error', `Duplicate entry for owner "${owner}".`);
      return;
    }

    ownerTokens[owner] = token;
  }

  try {
    await browser.storage.sync.set({
      githubToken: defaultToken,
      ownerTokens,
    });
    showStatus('success', 'Settings saved!');
  } catch (err) {
    console.error('[GitHub PR Enhancer] Failed to save settings:', err);
    showStatus('error', 'Failed to save: ' + err.message);
  }
});

loadSettings();
