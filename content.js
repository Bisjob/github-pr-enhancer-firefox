(() => {
  // Allow GitHub.com and GitHub Enterprise domains (*.ghe.com)
  // For enterprise, API endpoint is usually at https://<host>/api/v3
  function getApiBaseUrl() {
    const hostname = window.location.hostname;
    if (hostname === "github.com" || hostname.endsWith(".github.com")) {
      return "https://api.github.com";
    }
    if (hostname.endsWith(".ghe.com")) {
      return `${window.location.protocol}//${hostname}/api/v3`;
    }
    throw new Error(`Unsupported host for API access: ${hostname}`);
  }

  function isAllowedHost() {
    const hostname = window.location.hostname;
    return (
      hostname === "github.com" ||
      hostname.endsWith(".github.com") ||
      hostname.endsWith(".ghe.com")
    );
  }

  if (!isAllowedHost()) {
    return;
  }

  function getWebBaseUrl() {
    return `${window.location.protocol}//${window.location.hostname}`;
  }

  // Check if current page is a PR list page and extract repo info
  function checkAndGetRepoInfo() {
    const pathname = window.location.pathname;
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/pulls/);
    if (!match) {
      return null;
    }
    return { owner: match[1], repo: match[2] };
  }

  let repoInfo = checkAndGetRepoInfo();
  let rowPromises = new WeakMap();
  const ROW_SELECTOR = ".js-issue-row";
  const SPAN_CLASS = "github-show-reviewer";
  let currentUrl = window.location.href;
  let observer = null;
  let rowReviewerData = new WeakMap();
  // Cached data per row for re-rendering without repeating API calls
  let rowFullData = new WeakMap();
  let allReviewers = new Map();
  let activeFilter = null;
  let filterBar = null;

  // Display toggles (kept in sync with storage)
  const TOGGLE_DEFAULTS = {
    showStatusTags: true,
    showReviewers: true,
    showDates: true,
    showDeployments: true,
    showFilterBar: true,
  };
  let displayToggles = { ...TOGGLE_DEFAULTS };

  async function loadDisplayToggles() {
    try {
      const result = await browser.storage.sync.get(['displayToggles']);
      displayToggles = { ...TOGGLE_DEFAULTS, ...(result.displayToggles || {}) };
    } catch { /* use defaults */ }
  }
  loadDisplayToggles();
  const TEAM_ICON = `<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16" class="octicon octicon-people">
    <path d="M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z"></path>
  </svg>`;
  const COMMIT_ICON = `<svg aria-hidden="true" height="12" viewBox="0 0 16 16" width="12" class="octicon octicon-git-commit"><path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"></path></svg>`;
  const EYE_ICON = `<svg aria-hidden="true" height="12" viewBox="0 0 16 16" width="12" class="octicon octicon-eye"><path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"></path></svg>`;
  let initializationTimeout = null;

  function getCurrentUserLogin() {
    return document.querySelector('meta[name="user-login"]')?.getAttribute('content') || null;
  }

  // Get GitHub API headers, picking the most specific token available.
  // Priority: per-owner token > default token > no auth.
  async function getApiHeaders() {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    try {
      const result = await browser.storage.sync.get(["githubToken", "ownerTokens"]);

      // Resolve the owner from the current repo context (may be null on non-PR pages)
      const owner = repoInfo?.owner || null;
      const ownerToken = owner && result.ownerTokens?.[owner];
      const token = ownerToken || result.githubToken || null;

      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    } catch (error) {
      console.error(
        "[GitHub PR Enhancer] Failed to get token from storage:",
        error,
      );
    }

    return headers;
  }

  // Create and return span element for displaying reviewer info in PR row
  function ensureInfoSpan(row) {
    const metaContainer = row.querySelector(
      ".d-flex.mt-1.text-small.color-fg-muted",
    );
    if (!metaContainer) {
      return null;
    }

    let inlineFlexContainer = metaContainer.querySelector(
      ".d-none.d-md-inline-flex",
    );
    if (!inlineFlexContainer) {
      inlineFlexContainer = document.createElement("span");
      inlineFlexContainer.className = "d-none d-md-inline-flex";
      metaContainer.appendChild(inlineFlexContainer);
    }

    // DOM structure before insertion:
    // <span class="d-none d-md-inline-flex">
    //   <span class="d-inline-block ml-1">•Draft</span>
    //   <span class="issue-meta-section ml-2">...</span>
    // </span>

    let reviewerSpan = inlineFlexContainer.querySelector(`.${SPAN_CLASS}`);
    if (!reviewerSpan) {
      reviewerSpan = document.createElement('span');
      reviewerSpan.className = `${SPAN_CLASS} issue-meta-section`;
    }
    inlineFlexContainer.appendChild(reviewerSpan);

    // DOM structure after insertion:
    // <span class="d-none d-md-inline-flex">
    //   <span class="d-inline-block ml-1">•Draft</span>
    //   <span class="issue-meta-section ml-2">...</span>
    //   <span class="github-show-reviewer issue-meta-section ml-1">...</span>
    // </span>

    return reviewerSpan;
  }

  function extractPrNumber(row) {
    // Try extracting from row.id (e.g., "issue_123" → "123")
    if (row.id) {
      const byId = row.id.match(/issue_(\d+)/);
      if (byId) {
        return byId[1];
      }
    }

    // Fallback: extract from PR link
    const link = row.querySelector('a.Link--primary[href*="/pull/"]');
    if (link) {
      const match = link.getAttribute("href").match(/\/pull\/(\d+)/);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  function formatReviewerAvatars(reviewers) {
    if (!reviewers || reviewers.length === 0) {
      return '<span class="reviewer-separator">•</span><span>Reviewer: </span> <span class="reviewer-none">None</span>';
    }

    const MAX_VISIBLE = 5;
    const visibleReviewers = reviewers.slice(0, MAX_VISIBLE);
    const overflowCount = reviewers.length - MAX_VISIBLE;

    const avatarElements = visibleReviewers.map((reviewer) => {
      if (reviewer.isTeam) {
        return `<span class="reviewer-team-badge tooltipped tooltipped-s" aria-label="@${reviewer.login}" data-login="${reviewer.login}" data-is-team="true">
          ${TEAM_ICON} <span class="team-name">@${reviewer.login}</span>
        </span>`;
      } else {
        // User avatar
        const avatarUrl =
          reviewer.avatarUrl ||
          `${getWebBaseUrl()}/${reviewer.login}.png?size=40`;
        const stateClass =
          reviewer.state === "APPROVED"
            ? " reviewer-state-approved"
            : reviewer.state === "CHANGES_REQUESTED"
              ? " reviewer-state-changes-requested"
              : "";
        const stateLabel =
          reviewer.state === "APPROVED"
            ? " (approved)"
            : reviewer.state === "CHANGES_REQUESTED"
              ? " (changes requested)"
              : "";
        return `<span class="reviewer-avatar-link${stateClass} tooltipped tooltipped-s" aria-label="${reviewer.login}${stateLabel}" data-login="${reviewer.login}" data-type="${reviewer.type}">
          <img src="${avatarUrl}" alt="${reviewer.login}" class="reviewer-avatar" loading="lazy" />
        </span>`;
      }
    });

    let overflowBadge = "";
    if (overflowCount > 0) {
      overflowBadge = `<span class="reviewer-overflow-badge" title="${reviewers
        .slice(MAX_VISIBLE)
        .map((r) => (r.isTeam ? "@" + r.login : r.login))
        .join(", ")}">+${overflowCount}</span>`;
    }

    return `<span class="reviewer-separator">•</span><span class="reviewer-avatars-container">${avatarElements.join("")}${overflowBadge}</span>`;
  }

  // Update span element content with optional eye icon and error styling
  function setSpanText(span, text, isError = false) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const fragment = document.createDocumentFragment();
    while (doc.body.firstChild) {
      fragment.appendChild(document.adoptNode(doc.body.firstChild));
    }
    span.replaceChildren(fragment);
    span.classList.toggle(`${SPAN_CLASS}--success`, !isError);
    span.classList.toggle(`${SPAN_CLASS}--error`, isError);
  }

  // Check if a user is a bot
  function isBot(login) {
    if (!login) return false;
    const lowerLogin = login.toLowerCase();
    return (
      lowerLogin.includes("bot") ||
      lowerLogin === "renovate" ||
      lowerLogin === "github-actions"
    );
  }

  // Fetch the date of a specific commit via the git objects API
  // API endpoint: GET /repos/{owner}/{repo}/git/commits/{sha}
  async function fetchCommitDate(headSha) {
    const apiBase = getApiBaseUrl();
    const commitUrl = `${apiBase}/repos/${repoInfo.owner}/${repoInfo.repo}/git/commits/${headSha}`;
    try {
      const headers = await getApiHeaders();
      const response = await fetch(commitUrl, { headers });
      if (!response.ok) return null;
      const data = await response.json();
      return data.committer?.date || data.author?.date || null;
    } catch {
      return null;
    }
  }

  // Fetch CI status for a commit SHA
  // API endpoints:
  // - Check runs:    GET /repos/{owner}/{repo}/commits/{sha}/check-runs?filter=latest
  // - Legacy status: GET /repos/{owner}/{repo}/commits/{sha}/status
  // Fetch CI check-runs and legacy statuses for a commit SHA.
  // Returns { checks: [{ name, ciState: 'success'|'failure'|'pending' }] }
  // API endpoints:
  // - Check runs:    GET /repos/{owner}/{repo}/commits/{sha}/check-runs?filter=latest
  // - Legacy status: GET /repos/{owner}/{repo}/commits/{sha}/status
  async function fetchCiStatus(headSha) {
    const apiBase = getApiBaseUrl();
    const headers = await getApiHeaders();
    const checkRunsUrl = `${apiBase}/repos/${repoInfo.owner}/${repoInfo.repo}/commits/${headSha}/check-runs?filter=latest&per_page=100`;
    const statusUrl = `${apiBase}/repos/${repoInfo.owner}/${repoInfo.repo}/commits/${headSha}/status`;
    try {
      const [checkRunsResponse, statusResponse] = await Promise.all([
        fetch(checkRunsUrl, { headers }),
        fetch(statusUrl, { headers }),
      ]);

      const checks = [];

      if (checkRunsResponse.ok) {
        const data = await checkRunsResponse.json();
        for (const run of data.check_runs || []) {
          if (run.conclusion === 'cancelled') continue; // skip superseded runs
          let ciState;
          if (run.status !== 'completed') {
            ciState = 'pending';
          } else if (['failure', 'action_required', 'timed_out'].includes(run.conclusion)) {
            ciState = 'failure';
          } else {
            ciState = 'success';
          }
          checks.push({ name: run.name, ciState });
        }
      }

      if (statusResponse.ok) {
        const data = await statusResponse.json();
        for (const s of data.statuses || []) {
          let ciState;
          if (s.state === 'pending') ciState = 'pending';
          else if (s.state === 'failure' || s.state === 'error') ciState = 'failure';
          else ciState = 'success';
          checks.push({ name: s.context, ciState });
        }
      }

      return { checks };
    } catch {
      return { checks: [] };
    }
  }

  // Fetch branch protection rules to determine required approvals count and required check names.
  // API endpoint: GET /repos/{owner}/{repo}/branches/{branch}
  async function fetchBranchProtection(baseRef) {
    const apiBase = getApiBaseUrl();
    const url = `${apiBase}/repos/${repoInfo.owner}/${repoInfo.repo}/branches/${encodeURIComponent(baseRef)}`;
    try {
      const headers = await getApiHeaders();
      const resp = await fetch(url, { headers });
      if (!resp.ok) return null;
      const data = await resp.json();
      const protection = data.protection;
      if (!protection) return null;
      const requiredApprovals = protection.required_pull_request_reviews?.required_approving_review_count ?? null;
      // Merge legacy `contexts` array and new `checks` array (both may be present)
      const legacyContexts = protection.required_status_checks?.contexts || [];
      const newChecks = (protection.required_status_checks?.checks || []).map((c) => c.context);
      const requiredChecks = [...new Set([...legacyContexts, ...newChecks])];
      return { requiredApprovals, requiredChecks };
    } catch {
      return null;
    }
  }

  // Fetch deployments for a specific SHA
  // API endpoints:
  // - Deployments: GET /repos/{owner}/{repo}/deployments?sha={sha}
  // - Deployment statuses: GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses
  async function fetchDeployments(headSha) {
    const apiBase = getApiBaseUrl();
    const deploymentsUrl = `${apiBase}/repos/${repoInfo.owner}/${repoInfo.repo}/deployments?sha=${headSha}&per_page=10`;

    try {
      const headers = await getApiHeaders();
      const deploymentsResponse = await fetch(deploymentsUrl, { headers });

      if (!deploymentsResponse.ok) {
        return [];
      }

      const deployments = await deploymentsResponse.json();
      if (!Array.isArray(deployments) || deployments.length === 0) {
        return [];
      }

      // Fetch latest status for each deployment (in parallel)
      const deploymentResults = await Promise.all(
        deployments.map(async (deployment) => {
          const statusUrl = `${apiBase}/repos/${repoInfo.owner}/${repoInfo.repo}/deployments/${deployment.id}/statuses?per_page=1`;
          try {
            const statusResponse = await fetch(statusUrl, { headers });
            if (!statusResponse.ok) {
              return null;
            }
            const statuses = await statusResponse.json();
            const latestStatus = Array.isArray(statuses) && statuses.length > 0 ? statuses[0] : null;

            const state = latestStatus ? latestStatus.state : 'pending';
            return {
              environment: deployment.environment,
              state,
              deployedAt: deployment.created_at,
              // For inactive deployments, track when it was superseded
              supersededAt: state === 'inactive' && latestStatus ? latestStatus.updated_at : null,
            };
          } catch {
            return null;
          }
        })
      );

      // Filter out nulls and deduplicate by environment (keep most recent)
      const envMap = new Map();
      for (const result of deploymentResults) {
        if (result && !envMap.has(result.environment)) {
          envMap.set(result.environment, result);
        }
      }

      return Array.from(envMap.values());
    } catch (error) {
      console.error('[GitHub PR Enhancer] Deployments fetch error:', error);
      return [];
    }
  }

  // Abbreviate environment names for display
  function abbreviateEnvName(name) {
    const abbrevMap = {
      'production': 'prod',
      'staging': 'stg',
      'development': 'dev',
    };
    const lower = name.toLowerCase();
    return abbrevMap[lower] || (name.length > 10 ? name.substring(0, 8) + '…' : name);
  }

  // Format relative time for tooltip
  function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  }

  // Encode a plain string (may contain newlines) for safe embedding as an HTML attribute value.
  // The browser decodes the entity references back when getAttribute() is called.
  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '&#10;');
  }

  // Format review approval and CI status as compact tags.
  // Each tag has a multiline data-tooltip listing every condition and its state.
  function formatStatusTags(reviewStatus, ciStatus) {
    let html = '';

    // ── Review tag ────────────────────────────────────────────────────────────
    if (reviewStatus?.state !== 'none') {
      const req = reviewStatus.requiredApprovals;
      const approved = reviewStatus.approvedCount ?? 0;

      // Line 1: summary
      const summaryLine = req !== null
        ? `Approvals: ${approved}/${req} required`
        : `Approvals: ${approved}`;

      // One line per reviewer
      const reviewerLines = (reviewStatus.reviewerDetails || []).map((r) => {
        const icon = r.status === 'approved' ? '✓' : r.status === 'changes' ? '✗' : '⏳';
        const label = r.status === 'approved' ? 'approved'
          : r.status === 'changes' ? 'changes requested'
          : 'pending';
        return `${icon} ${r.isTeam ? '@' : ''}${r.login} — ${label}`;
      });

      const tooltip = escapeAttr([summaryLine, ...reviewerLines].join('\n'));

      let tagClass, tagLabel;
      if (reviewStatus.state === 'changes') {
        tagClass = 'pr-status--changes';
        tagLabel = req !== null ? `✗ ${approved}/${req}` : '✗ Changes';
      } else if (reviewStatus.state === 'approved') {
        tagClass = 'pr-status--approved';
        tagLabel = req !== null ? `✓ ${approved}/${req}` : '✓ Approved';
      } else {
        tagClass = 'pr-status--review-pending';
        tagLabel = req !== null ? `⏳ ${approved}/${req}` : '⏳ Reviews';
      }

      html += `<span class="pr-status-tag ${tagClass}" data-tooltip="${tooltip}">${tagLabel}</span>`;
    }

    // ── CI tag ────────────────────────────────────────────────────────────────
    const checks = ciStatus?.checks || [];
    if (checks.length > 0) {
      const hasRequiredFlag = checks.some((c) => !c.required); // at least one optional → flag is meaningful
      // Determine overall state from required checks only
      const requiredChecks = checks.filter((c) => c.required);
      const hasFailures = requiredChecks.some((c) => c.ciState === 'failure');
      const hasPending  = requiredChecks.some((c) => c.ciState === 'pending');

      // Sort: failures first, then pending, then success; required before optional
      const sorted = [...checks].sort((a, b) => {
        const order = { failure: 0, pending: 1, success: 2 };
        if (a.required !== b.required) return a.required ? -1 : 1;
        return (order[a.ciState] ?? 3) - (order[b.ciState] ?? 3);
      });

      const tooltipLines = sorted.map((c) => {
        const icon = c.ciState === 'success' ? '✓' : c.ciState === 'failure' ? '✗' : '⏳';
        const suffix = hasRequiredFlag ? (c.required ? ' ★' : '') : '';
        return `${icon} ${c.name}${suffix}`;
      });
      if (hasRequiredFlag) tooltipLines.push('(★ = required)');

      const tooltip = escapeAttr(tooltipLines.join('\n'));

      let tagClass, tagLabel;
      if (hasFailures) {
        tagClass = 'pr-status--ci-failure';
        tagLabel = '✗ CI';
      } else if (hasPending) {
        tagClass = 'pr-status--ci-pending';
        tagLabel = '● CI';
      } else {
        tagClass = 'pr-status--ci-success';
        tagLabel = '✓ CI';
      }

      html += `<span class="pr-status-tag ${tagClass}" data-tooltip="${tooltip}">${tagLabel}</span>`;
    }

    if (!html) return '';
    return `<span class="reviewer-separator">•</span><span class="pr-status-tags-container">${html}</span>`;
  }

  // Format last commit date and current user's last review as compact badges
  function formatDatesInfo(lastCommitDate, myLastReview) {
    let html = '';

    if (lastCommitDate) {
      const relTime = formatRelativeTime(lastCommitDate);
      const fullDate = new Date(lastCommitDate).toLocaleString();
      html += `<span class="reviewer-separator">•</span><span class="pr-date-badge pr-commit-date tooltipped tooltipped-s" aria-label="Last commit: ${fullDate}">${COMMIT_ICON}${relTime}</span>`;
    }

    if (myLastReview) {
      const relTime = formatRelativeTime(myLastReview.date);
      const fullDate = new Date(myLastReview.date).toLocaleString();
      const stateLabel =
        myLastReview.state === 'APPROVED' ? 'Approved'
        : myLastReview.state === 'CHANGES_REQUESTED' ? 'Changes requested'
        : 'Reviewed';
      const stateClass =
        myLastReview.state === 'APPROVED' ? ' pr-review-date--approved'
        : myLastReview.state === 'CHANGES_REQUESTED' ? ' pr-review-date--changes'
        : '';
      html += `<span class="reviewer-separator">•</span><span class="pr-date-badge pr-review-date${stateClass} tooltipped tooltipped-s" aria-label="My review: ${stateLabel} (${fullDate})">${EYE_ICON}${relTime}</span>`;
    }

    return html;
  }

  // Format deployment badges HTML
  function formatDeploymentBadges(deployments) {
    if (!deployments || deployments.length === 0) {
      return '';
    }

    const badges = deployments.map((deployment) => {
      const abbrevName = abbreviateEnvName(deployment.environment);
      const stateClass = `deployment-badge--${deployment.state}`;
      let tooltip;
      if (deployment.state === 'inactive' && deployment.supersededAt) {
        tooltip = `${deployment.environment}: deployed ${formatRelativeTime(deployment.deployedAt)}, superseded ${formatRelativeTime(deployment.supersededAt)}`;
      } else {
        tooltip = `${deployment.environment}: ${deployment.state} (${formatRelativeTime(deployment.deployedAt)})`;
      }

      return `<span class="deployment-badge ${stateClass} tooltipped tooltipped-s" aria-label="${tooltip}">${abbrevName}</span>`;
    });

    return `<span class="reviewer-separator">•</span><span class="deployment-badges-container">${badges.join('')}</span>`;
  }

  // Fetch reviewers from GitHub API
  // API endpoints:
  // - Pull request details: GET /repos/{owner}/{repo}/pulls/{prNumber}
  // - Pull request reviews: GET /repos/{owner}/{repo}/pulls/{prNumber}/reviews
  async function fetchReviewers(prNumber) {
    const apiBase = getApiBaseUrl();
    const pullUrl = `${apiBase}/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}`;
    const reviewsUrl = `${pullUrl}/reviews`;

    try {
      const headers = await getApiHeaders();
      const [pullResponse, reviewsResponse] = await Promise.all([
        fetch(pullUrl, { headers }),
        fetch(reviewsUrl, { headers }),
      ]);

      if (!pullResponse.ok) {
        const errorText = await pullResponse.text();
        console.error(`[GitHub PR Enhancer] API Error:`, errorText);
        throw new Error(
          `GitHub API error ${pullResponse.status}: ${errorText.substring(0, 100)}`,
        );
      }

      const pullData = await pullResponse.json();
      const headSha = pullData.head?.sha;

      // Fetch deployments, commit date, CI status, and branch protection rules in parallel
      const deploymentsPromise = headSha ? fetchDeployments(headSha) : Promise.resolve([]);
      const commitDatePromise = headSha ? fetchCommitDate(headSha) : Promise.resolve(null);
      const ciStatusPromise = headSha ? fetchCiStatus(headSha) : Promise.resolve({ checks: [] });
      const branchProtectionPromise = fetchBranchProtection(pullData.base.ref);

      // Extract requested reviewers (excluding bots)
      const requestedUsers = Array.isArray(pullData.requested_reviewers)
        ? pullData.requested_reviewers
            .filter((user) => !isBot(user.login))
            .map((user) => ({
              login: user.login,
              avatarUrl: user.avatar_url,
              type: "requested",
              isTeam: false,
            }))
        : [];

      // Extract requested teams
      const requestedTeams = Array.isArray(pullData.requested_teams)
        ? pullData.requested_teams.map((team) => ({
            login: team.slug,
            type: "requested",
            isTeam: true,
          }))
        : [];

      let reviews = [];
      if (reviewsResponse.ok) {
        reviews = await reviewsResponse.json();
      }

      // Find the current authenticated user's most recent review
      const currentUserLogin = getCurrentUserLogin();
      let myLastReview = null;
      if (currentUserLogin && Array.isArray(reviews)) {
        const myReviews = reviews.filter((r) =>
          r &&
          r.user?.login === currentUserLogin &&
          r.state &&
          r.state.toUpperCase() !== 'PENDING' &&
          r.submitted_at,
        );
        if (myReviews.length > 0) {
          myReviews.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
          const latest = myReviews[0];
          myLastReview = { date: latest.submitted_at, state: latest.state.toUpperCase() };
        }
      }

      // Extract users who have reviewed (exclude PR author and bots).
      // Use a Map keyed by login so that iterating forward naturally keeps
      // the last (most recent) review per user.
      const reviewMap = new Map();
      if (Array.isArray(reviews)) {
        for (const review of reviews) {
          if (
            review &&
            review.user &&
            review.user.login &&
            review.state &&
            review.state.toUpperCase() !== "PENDING" &&
            review.user.login !== pullData.user.login &&
            !isBot(review.user.login)
          ) {
            reviewMap.set(review.user.login, review);
          }
        }
      }
      const reviewedUsers = Array.from(reviewMap.values()).map((review) => ({
        login: review.user.login,
        avatarUrl: review.user.avatar_url,
        type: "reviewed",
        state: review.state.toUpperCase(),
        isTeam: false,
      }));

      // Deduplicate by login
      const combined = [...requestedUsers, ...requestedTeams, ...reviewedUsers];
      const seenLogins = new Set();
      const reviewers = [];
      for (const reviewer of combined) {
        const key = reviewer.isTeam ? `@${reviewer.login}` : reviewer.login;
        if (!seenLogins.has(key)) {
          seenLogins.add(key);
          reviewers.push(reviewer);
        }
      }

      const [deployments, lastCommitDate, ciRaw, branchProtection] = await Promise.all([
        deploymentsPromise, commitDatePromise, ciStatusPromise, branchProtectionPromise,
      ]);

      // Compute review approval status using required count from branch protection
      const requiredApprovals = branchProtection?.requiredApprovals ?? null;
      const pendingReviewerDetails = [
        ...requestedUsers.map((r) => ({ login: r.login, isTeam: false, status: 'pending' })),
        ...requestedTeams.map((r) => ({ login: r.login, isTeam: true, status: 'pending' })),
      ];
      const reviewedDetails = reviewedUsers.map((r) => ({
        login: r.login,
        isTeam: false,
        status: r.state === 'APPROVED' ? 'approved'
          : r.state === 'CHANGES_REQUESTED' ? 'changes'
          : 'commented',
      }));
      const allReviewerDetails = [...pendingReviewerDetails, ...reviewedDetails];
      const approvedCount = reviewedUsers.filter((r) => r.state === 'APPROVED').length;
      const changesCount = reviewedUsers.filter((r) => r.state === 'CHANGES_REQUESTED').length;

      let reviewStatus;
      if (allReviewerDetails.length === 0) {
        reviewStatus = { state: 'none' };
      } else if (changesCount > 0) {
        reviewStatus = { state: 'changes', approvedCount, requiredApprovals, reviewerDetails: allReviewerDetails };
      } else if (requiredApprovals !== null
        ? approvedCount >= requiredApprovals
        : pendingReviewerDetails.length === 0 && approvedCount > 0) {
        reviewStatus = { state: 'approved', approvedCount, requiredApprovals, reviewerDetails: allReviewerDetails };
      } else {
        reviewStatus = { state: 'pending', approvedCount, requiredApprovals, reviewerDetails: allReviewerDetails };
      }

      // Enrich CI checks with whether they are required per branch protection
      const requiredCheckNames = new Set(branchProtection?.requiredChecks || []);
      const hasProtectedChecks = requiredCheckNames.size > 0;
      const ciStatus = {
        checks: ciRaw.checks.map((c) => ({
          ...c,
          required: !hasProtectedChecks || requiredCheckNames.has(c.name),
        })),
      };

      return { reviewers, deployments, lastCommitDate, myLastReview, reviewStatus, ciStatus };
    } catch (error) {
      return { error: error.message || "Unknown error" };
    }
  }

  function updateRow(row) {
    const prNumber = extractPrNumber(row);
    if (!prNumber) {
      return;
    }

    const infoSpan = ensureInfoSpan(row);
    if (!infoSpan) {
      return;
    }

    // Skip if already processing (prevent duplicate requests)
    if (rowPromises.has(row)) {
      return;
    }

    setSpanText(
      infoSpan,
      '<span class="reviewer-separator">•</span><span>Reviewer: </span> Loading...',
      false,
    );
    infoSpan.removeAttribute("title");

    const promise = fetchReviewers(prNumber);
    rowPromises.set(row, promise);

    promise.then(({ reviewers, deployments, lastCommitDate, myLastReview, reviewStatus, ciStatus, error }) => {
      if (rowPromises.get(row) !== promise) {
        return;
      }

      if (error) {
        setSpanText(
          infoSpan,
          '<span class="reviewer-separator">•</span><span>Reviewer: </span> <span class="reviewer-na">N/A</span>',
          true,
        );
        infoSpan.title = error;
        return;
      }

      const statusTagsHtml = displayToggles.showStatusTags ? formatStatusTags(reviewStatus, ciStatus) : '';
      const datesInfoHtml = displayToggles.showDates ? formatDatesInfo(lastCommitDate, myLastReview) : '';
      const deploymentBadgesHtml = displayToggles.showDeployments ? formatDeploymentBadges(deployments) : '';
      const reviewersHtml = displayToggles.showReviewers ? formatReviewerAvatars(reviewers) : '';
      setSpanText(infoSpan, statusTagsHtml + datesInfoHtml + deploymentBadgesHtml + reviewersHtml, false);
      infoSpan.removeAttribute('title');
      rowReviewerData.set(row, reviewers);
      rowFullData.set(row, { reviewers, deployments, lastCommitDate, myLastReview, reviewStatus, ciStatus });
      let barChanged = false;
      for (const r of reviewers) {
        const key = r.isTeam ? `@${r.login}` : r.login;
        if (!allReviewers.has(key)) {
          allReviewers.set(key, r);
          barChanged = true;
        }
      }
      renderFilterBar();
      if (activeFilter) filterRow(row);
    });
    promise.finally(() => {
      if (rowPromises.get(row) === promise) {
        rowPromises.delete(row);
      }
    });
  }

  function processRows(root = document) {
    const rows = root.querySelectorAll(ROW_SELECTOR);
    rows.forEach((row) => {
      updateRow(row);
    });
  }

  function filterRow(row) {
    if (!activeFilter) {
      row.style.display = "";
      return;
    }
    const reviewers = rowReviewerData.get(row);
    if (!reviewers) {
      row.style.display = "none";
      return;
    }
    const match = reviewers.find(
      (r) => r.login === activeFilter.login && r.isTeam === activeFilter.isTeam,
    );
    if (
      !match ||
      match.state === "APPROVED" ||
      match.state === "CHANGES_REQUESTED"
    ) {
      row.style.display = "none";
    } else {
      row.style.display = "";
    }
  }

  function applyFilter() {
    document.querySelectorAll(ROW_SELECTOR).forEach(filterRow);
  }

  function ensureFilterBar() {
    if (filterBar && document.contains(filterBar)) return filterBar;
    document
      .querySelectorAll(".github-show-reviewer-filter")
      .forEach((el) => el.remove());
    filterBar = null;
    const firstRow = document.querySelector(ROW_SELECTOR);
    if (!firstRow) return null;
    filterBar = document.createElement("div");
    filterBar.className = "github-show-reviewer-filter pl-3";
    filterBar.style.display = "none";
    firstRow.parentNode.insertBefore(filterBar, firstRow);

    filterBar.addEventListener('click', (e) => {
      const el = e.target.closest('[aria-label]');
      if (!el || !filterBar.contains(el)) return;
      const ariaLabel = el.getAttribute('aria-label');
      const isTeam = ariaLabel.startsWith('@');
      const login = isTeam ? ariaLabel.substring(1) : ariaLabel;
      toggleFilter(login, isTeam);
    });

    filterBar.addEventListener('mouseenter', (e) => {
      const el = e.target.closest('[aria-label]');
      if (!el || !filterBar.contains(el)) return;
      const text = el.getAttribute('aria-label');
      if (text) showTooltip(el, text);
    }, true);

    filterBar.addEventListener('mouseleave', (e) => {
      const el = e.target.closest('[aria-label]');
      if (!el || !filterBar.contains(el)) return;
      hideTooltip();
    }, true);

    return filterBar;
  }

  function hasPendingReviews(reviewer) {
    // Check all rows to see if this reviewer has any pending reviews
    const rows = document.querySelectorAll(ROW_SELECTOR);
    for (const row of rows) {
      const reviewers = rowReviewerData.get(row);
      if (!reviewers) continue;

      const match = reviewers.find(
        (r) => r.login === reviewer.login && r.isTeam === reviewer.isTeam,
      );
      if (
        match &&
        match.state !== "APPROVED" &&
        match.state !== "CHANGES_REQUESTED"
      ) {
        return true;
      }
    }
    return false;
  }

  function renderFilterBar() {
    const bar = ensureFilterBar();
    if (!bar) return;

    const sorted = Array.from(allReviewers.values()).sort((a, b) =>
      a.login.localeCompare(b.login, undefined, { sensitivity: "base" }),
    );

    const fragment = document.createDocumentFragment();
    const label = document.createElement('span');
    label.className = 'reviewer-filter-label';
    label.textContent = 'Pending reviews by:';
    fragment.appendChild(label);

    let hasVisibleReviewers = false;

    for (const reviewer of sorted) {
      // Only show reviewers that have pending reviews
      if (!hasPendingReviews(reviewer)) {
        continue;
      }

      hasVisibleReviewers = true;
      const isActive =
        activeFilter &&
        activeFilter.login === reviewer.login &&
        activeFilter.isTeam === reviewer.isTeam;

      const btn = document.createElement('button');
      if (reviewer.isTeam) {
        btn.className = `reviewer-filter-team tooltipped tooltipped-s${isActive ? ' reviewer-filter-team--active' : ''}`;
        btn.setAttribute('aria-label', `@${reviewer.login}`);
        const svgDoc = new DOMParser().parseFromString(TEAM_ICON, 'image/svg+xml');
        btn.appendChild(document.adoptNode(svgDoc.documentElement));
      } else {
        const avatarUrl =
          reviewer.avatarUrl ||
          `${getWebBaseUrl()}/${reviewer.login}.png?size=40`;
        btn.className = `reviewer-filter-avatar tooltipped tooltipped-s${isActive ? ' reviewer-filter-avatar--active' : ''}`;
        btn.setAttribute('aria-label', reviewer.login);
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = reviewer.login;
        img.loading = 'lazy';
        btn.appendChild(img);
      }
      fragment.appendChild(btn);
    }

    bar.replaceChildren(fragment);
    bar.style.display = (hasVisibleReviewers && displayToggles.showFilterBar) ? 'flex' : 'none';
  }

  function toggleFilter(login, isTeam) {
    if (
      activeFilter &&
      activeFilter.login === login &&
      activeFilter.isTeam === isTeam
    ) {
      clearFilter();
    } else {
      activeFilter = { login, isTeam };
      renderFilterBar();
      applyFilter();
    }
  }

  function clearFilter() {
    activeFilter = null;
    renderFilterBar();
    applyFilter();
  }

  // Initialize extension (re-run when URL changes)
  function initializeExtension() {
    const newRepoInfo = checkAndGetRepoInfo();

    if (!newRepoInfo) {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      allReviewers.clear();
      activeFilter = null;
      if (filterBar) {
        filterBar.remove();
        filterBar = null;
      }
      repoInfo = null;
      return;
    }

    // Only clear data if we've switched to a different repo
    const switchedRepo =
      !repoInfo ||
      repoInfo.owner !== newRepoInfo.owner ||
      repoInfo.repo !== newRepoInfo.repo;
    if (switchedRepo) {
      rowPromises = new WeakMap();
      rowFullData = new WeakMap();
      allReviewers.clear();
      activeFilter = null;
      applyFilter();
      repoInfo = newRepoInfo;
    }

    const bar = ensureFilterBar();
    if (bar) {
      if (switchedRepo) {
        bar.innerHTML =
          '<span class="reviewer-filter-label">Pending reviews by:</span><span class="reviewer-filter-loading">Loading...</span>';
        bar.style.display = "flex";
      } else if (allReviewers.size > 0) {
        renderFilterBar();
      }
    }

    if (!observer) {
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => {
            if (!(node instanceof HTMLElement)) {
              return;
            }
            if (node.matches?.(ROW_SELECTOR)) {
              updateRow(node);
            }
            const nestedRows = node.querySelectorAll?.(ROW_SELECTOR);
            if (nestedRows && nestedRows.length > 0) {
              nestedRows.forEach((row) => {
                updateRow(row);
              });
            }
          });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    processRows();
  }

  // Monitor URL changes (for SPA navigation)
  function checkUrlChange() {
    const newUrl = window.location.href;
    if (newUrl !== currentUrl) {
      currentUrl = newUrl;

      // Clear any pending initialization
      if (initializationTimeout) {
        clearTimeout(initializationTimeout);
      }

      // Debounce initialization to prevent rapid flashing
      initializationTimeout = setTimeout(() => {
        initializeExtension();
        initializationTimeout = null;
      }, 300);
    }
  }

  setInterval(checkUrlChange, 1000);

  window.addEventListener("popstate", () => {
    checkUrlChange();
  });

  initializeExtension();

  // Re-render all rows immediately when display toggles change in storage
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.displayToggles) return;
    displayToggles = { ...TOGGLE_DEFAULTS, ...(changes.displayToggles.newValue || {}) };

    // Re-render all rows that already have fetched data
    document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
      const data = rowFullData.get(row);
      if (!data) return;
      const infoSpan = ensureInfoSpan(row);
      if (!infoSpan) return;
      const { reviewers, deployments, lastCommitDate, myLastReview, reviewStatus, ciStatus } = data;
      const statusTagsHtml = displayToggles.showStatusTags ? formatStatusTags(reviewStatus, ciStatus) : '';
      const datesInfoHtml = displayToggles.showDates ? formatDatesInfo(lastCommitDate, myLastReview) : '';
      const deploymentBadgesHtml = displayToggles.showDeployments ? formatDeploymentBadges(deployments) : '';
      const reviewersHtml = displayToggles.showReviewers ? formatReviewerAvatars(reviewers) : '';
      setSpanText(infoSpan, statusTagsHtml + datesInfoHtml + deploymentBadgesHtml + reviewersHtml, false);
    });

    // Re-render filter bar (handles showFilterBar toggle)
    renderFilterBar();
  });

  // Custom tooltip system
  let tooltip = null;

  function createTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement("div");
    tooltip.className = "github-show-reviewer-tooltip";
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function showTooltip(element, text) {
    const tooltip = createTooltip();
    tooltip.textContent = text;
    tooltip.classList.add("visible");

    const rect = element.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    // Position tooltip above the element
    let top = rect.top - tooltipRect.height - 8;
    let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);

    // Keep tooltip within viewport
    if (top < 0) {
      top = rect.bottom + 8;
    }
    if (left < 0) {
      left = 8;
    }
    if (left + tooltipRect.width > window.innerWidth) {
      left = window.innerWidth - tooltipRect.width - 8;
    }

    tooltip.style.top = `${top + window.scrollY}px`;
    tooltip.style.left = `${left + window.scrollX}px`;
  }

  function hideTooltip() {
    if (tooltip) {
      tooltip.classList.remove("visible");
    }
  }

  // Delegate custom multiline tooltip for status tags (uses data-tooltip attribute)
  document.body.addEventListener('mouseenter', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (!el) return;
    showTooltip(el, el.getAttribute('data-tooltip'));
  }, true);
  document.body.addEventListener('mouseleave', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (!el) return;
    hideTooltip();
  }, true);

})();
