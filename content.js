(() => {
  if (window.location.hostname !== "github.com") {
    return;
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
  let allReviewers = new Map();
  let activeFilter = null;
  let filterBar = null;
  const TEAM_ICON = `<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16" class="octicon octicon-people">
    <path d="M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z"></path>
  </svg>`;
  let initializationTimeout = null;

  // Get GitHub API headers (includes token if available)
  async function getApiHeaders() {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    try {
      const result = await browser.storage.sync.get(["githubToken"]);
      if (result.githubToken) {
        headers.Authorization = `Bearer ${result.githubToken}`;
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
          `https://github.com/${reviewer.login}.png?size=40`;
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
    span.innerHTML = text;
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

  // Fetch deployments for a specific SHA
  // API endpoints:
  // - Deployments: GET /repos/{owner}/{repo}/deployments?sha={sha}
  // - Deployment statuses: GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses
  async function fetchDeployments(headSha) {
    const deploymentsUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/deployments?sha=${headSha}&per_page=10`;

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
          const statusUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/deployments/${deployment.id}/statuses?per_page=1`;
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
    const pullUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}`;
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

      // Fetch deployments in parallel with processing reviewers
      const deploymentsPromise = headSha ? fetchDeployments(headSha) : Promise.resolve([]);

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

      const deployments = await deploymentsPromise;

      return { reviewers, deployments };
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

    promise.then(({ reviewers, deployments, error }) => {
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

      const deploymentBadgesHtml = formatDeploymentBadges(deployments);
      setSpanText(infoSpan, deploymentBadgesHtml + formatReviewerAvatars(reviewers), false);
      infoSpan.removeAttribute('title');
      rowReviewerData.set(row, reviewers);
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

    let htmlContent =
      '<span class="reviewer-filter-label">Pending reviews by:</span>';
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

      if (reviewer.isTeam) {
        htmlContent += `<button class="reviewer-filter-team tooltipped tooltipped-s${isActive ? " reviewer-filter-team--active" : ""}" aria-label="@${reviewer.login}">
          ${TEAM_ICON}
        </button>`;
      } else {
        const avatarUrl =
          reviewer.avatarUrl ||
          `https://github.com/${reviewer.login}.png?size=40`;
        htmlContent += `<button class="reviewer-filter-avatar tooltipped tooltipped-s${isActive ? " reviewer-filter-avatar--active" : ""}" aria-label="${reviewer.login}">
          <img src="${avatarUrl}" alt="${reviewer.login}" loading="lazy">
        </button>`;
      }
    }

    bar.innerHTML = htmlContent;
    bar.style.display = hasVisibleReviewers ? 'flex' : 'none';
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
  

})();
