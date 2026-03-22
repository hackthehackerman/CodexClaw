export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeClaw Operator</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <div class="shell">
      <aside class="rail">
        <div class="rail-brand reveal">
          <p class="eyebrow">CodeClaw</p>
          <h1>Operator</h1>
          <p class="rail-copy">Sessions, approvals, and runtime settings in one local surface.</p>
        </div>
        <section class="rail-block reveal" style="--delay: 90ms">
          <div class="section-head">
            <p class="eyebrow">Overview</p>
            <div id="stats-strip" class="stats-strip"></div>
          </div>
        </section>
        <section class="rail-block reveal" style="--delay: 140ms">
          <div class="section-head">
            <p class="eyebrow">Live Sessions</p>
            <p id="session-count" class="section-meta"></p>
          </div>
          <div id="session-list" class="session-list"></div>
        </section>
      </aside>

      <main class="workspace">
        <header class="workspace-head reveal" style="--delay: 120ms">
          <div>
            <p class="eyebrow">Run Surface</p>
            <h2 id="workspace-title">Recent activity</h2>
          </div>
          <div class="workspace-meta">
            <p id="selected-summary" class="section-meta">Loading state…</p>
            <p id="last-sync" class="timestamp">Waiting for first poll</p>
          </div>
        </header>

        <section class="panel reveal" style="--delay: 180ms">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Runs</p>
              <h3>Recent turns</h3>
            </div>
            <p class="section-meta">Auto-refresh every three seconds</p>
          </div>
          <div id="run-list" class="run-list"></div>
        </section>

        <section class="panel reveal" style="--delay: 220ms">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Turn Detail</p>
              <h3>Exact input sent to Codex</h3>
            </div>
            <p id="turn-detail-meta" class="section-meta">Click a run to inspect its exact turn payload.</p>
          </div>
          <div class="detail-stack turn-detail-stack">
            <div class="detail-code">
              <p class="eyebrow">turn/start input array</p>
              <pre id="turn-input-json" class="code-block code-block--tall"></pre>
            </div>
            <div class="detail-code">
              <p class="eyebrow">full turn/start payload</p>
              <pre id="turn-request-json" class="code-block"></pre>
            </div>
            <div class="detail-code">
              <p class="eyebrow">turn result</p>
              <pre id="turn-response-json" class="code-block"></pre>
            </div>
          </div>
        </section>

        <section class="panel reveal" style="--delay: 260ms">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Approvals</p>
              <h3>Pending and recent decisions</h3>
            </div>
          </div>
          <div id="approval-list" class="approval-list"></div>
        </section>
      </main>

      <aside class="inspector">
        <section class="inspector-block reveal" style="--delay: 180ms">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Config</p>
              <h3>Common runtime settings</h3>
            </div>
            <p class="section-meta">Writes back to your TOML and applies to future turns.</p>
          </div>
          <form id="config-form" class="config-form">
            <label>
              <span>Bot name</span>
              <input name="botName" type="text" autocomplete="off" />
            </label>
            <label>
              <span>Aliases</span>
              <input name="aliases" type="text" autocomplete="off" placeholder="comma, separated, aliases" />
            </label>
            <label>
              <span>Model</span>
              <input name="model" type="text" autocomplete="off" placeholder="gpt-5.4" />
            </label>
            <label>
              <span>Effort</span>
              <select name="effort">
                <option value="">Default</option>
                <option value="none">none</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
            </label>
            <label>
              <span>Summary style</span>
              <input name="summary" type="text" autocomplete="off" />
            </label>
            <label class="toggle">
              <input name="allowSelfMessages" type="checkbox" />
              <span>Allow self-authored messages to enter the queue</span>
            </label>
            <div class="form-actions">
              <button type="submit">Save settings</button>
              <p id="form-status" class="section-meta"></p>
            </div>
          </form>
        </section>

        <section class="inspector-block reveal" style="--delay: 220ms">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Runtime</p>
              <h3>Workspaces and transports</h3>
            </div>
          </div>
          <div id="runtime-meta" class="runtime-meta"></div>
        </section>
      </aside>
    </div>
    <script type="module" src="/app.js"></script>
  </body>
</html>`;
}

export const dashboardCss = `
:root {
  --paper: #f4ede3;
  --paper-strong: #efe5d8;
  --ink: #1a1713;
  --ink-soft: rgba(26, 23, 19, 0.65);
  --rail: #121313;
  --rail-soft: rgba(255, 245, 231, 0.72);
  --line: rgba(24, 18, 13, 0.12);
  --accent: #b86a2e;
  --accent-soft: rgba(184, 106, 46, 0.14);
  --good: #2f7d53;
  --warn: #b07a21;
  --bad: #a04834;
  --shadow: 0 18px 40px rgba(18, 19, 19, 0.08);
  --sans: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
  --mono: "IBM Plex Mono", "SFMono-Regular", "Menlo", monospace;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
  width: 100%;
  background:
    radial-gradient(circle at top left, rgba(184, 106, 46, 0.1), transparent 28%),
    linear-gradient(180deg, #f7f1e8 0%, var(--paper) 100%);
  color: var(--ink);
  font-family: var(--sans);
  overflow-x: hidden;
}

body {
  min-height: 100vh;
}

button,
input,
select {
  font: inherit;
}

.shell {
  width: 100%;
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(250px, 290px) minmax(0, 1fr) minmax(300px, 360px);
}

.rail {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 18%),
    var(--rail);
  color: #fff5e7;
  padding: 28px 22px 24px;
  border-right: 1px solid rgba(255, 245, 231, 0.08);
}

.workspace,
.inspector {
  min-width: 0;
  padding: 28px 26px 24px;
}

.workspace {
  border-right: 1px solid var(--line);
}

.rail-brand,
.rail-block,
.workspace-head,
.panel,
.inspector-block {
  opacity: 0;
  transform: translateY(14px);
  animation: rise-in 520ms ease forwards;
  animation-delay: var(--delay, 0ms);
}

.rail-brand {
  margin-bottom: 28px;
}

.rail-copy {
  margin: 10px 0 0;
  color: var(--rail-soft);
  line-height: 1.5;
}

.rail h1,
.workspace-head h2,
.panel-head h3 {
  margin: 0;
  font-weight: 600;
  letter-spacing: -0.04em;
}

.rail h1 {
  font-size: clamp(2rem, 4vw, 2.75rem);
}

.workspace-head h2 {
  font-size: clamp(2rem, 4vw, 2.6rem);
}

.panel-head h3 {
  font-size: 1.25rem;
}

.eyebrow,
.timestamp,
.status-pill,
.meta-code,
.empty-state,
.section-meta {
  font-family: var(--mono);
  letter-spacing: 0.02em;
}

.eyebrow {
  margin: 0 0 8px;
  text-transform: uppercase;
  font-size: 0.72rem;
  color: inherit;
  opacity: 0.72;
}

.section-meta,
.timestamp {
  margin: 0;
  font-size: 0.76rem;
  color: var(--ink-soft);
}

.rail .section-meta {
  color: rgba(255, 245, 231, 0.62);
}

.rail-block,
.panel,
.inspector-block {
  border-top: 1px solid rgba(255, 245, 231, 0.08);
  padding-top: 18px;
  margin-top: 18px;
}

.workspace .panel,
.inspector-block {
  border-top-color: var(--line);
}

.section-head,
.panel-head,
.workspace-head,
.form-actions,
.meta-group,
.run-row,
.approval-row,
.session-button {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.workspace-head,
.panel-head {
  align-items: end;
}

.workspace-meta {
  text-align: right;
}

.stats-strip {
  display: grid;
  gap: 10px;
  margin-top: 10px;
}

.stat-line {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 245, 231, 0.08);
}

.stat-line:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

.stat-value {
  font-size: 1.4rem;
}

.session-list,
.run-list,
.approval-list,
.runtime-meta,
.detail-stack {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}

.session-button {
  width: 100%;
  padding: 14px 0;
  background: transparent;
  border: 0;
  color: inherit;
  text-align: left;
  border-bottom: 1px solid rgba(255, 245, 231, 0.08);
  cursor: pointer;
  transition: transform 160ms ease, color 160ms ease;
}

.session-button:hover,
.session-button:focus-visible {
  transform: translateX(6px);
  color: #ffffff;
  outline: none;
}

.session-button.is-active {
  color: #fff;
}

.session-button.is-active .session-title::before {
  transform: scaleX(1);
}

.session-main {
  min-width: 0;
}

.session-title {
  position: relative;
  display: inline-block;
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.session-title::before {
  content: "";
  position: absolute;
  left: 0;
  bottom: -4px;
  width: 100%;
  height: 2px;
  background: var(--accent);
  transform-origin: left;
  transform: scaleX(0);
  transition: transform 180ms ease;
}

.session-detail,
.run-detail,
.approval-detail {
  margin: 5px 0 0;
  color: var(--ink-soft);
  line-height: 1.4;
}

.rail .session-detail {
  color: rgba(255, 245, 231, 0.62);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 0.76rem;
  text-transform: uppercase;
  white-space: nowrap;
}

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.9;
}

.status-pill.status-in_progress {
  color: var(--accent);
}

.status-pill.status-completed {
  color: var(--good);
}

.status-pill.status-queued,
.status-pill.status-pending {
  color: var(--warn);
}

.status-pill.status-failed,
.status-pill.status-denied,
.status-pill.status-canceled {
  color: var(--bad);
}

.status-pill.status-approved {
  color: var(--good);
}

.status-pill.is-live .status-dot {
  animation: live-pulse 1.6s ease infinite;
}

.panel {
  padding-top: 20px;
}

.run-row,
.approval-row {
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
  transition: transform 160ms ease, background-color 160ms ease;
}

.run-row {
  cursor: pointer;
}

.run-row:hover,
.approval-row:hover {
  transform: translateX(4px);
  background: rgba(255, 255, 255, 0.4);
}

.run-row.is-active {
  background: rgba(184, 106, 46, 0.08);
}

.run-row.is-active .row-title {
  color: var(--accent);
}

.row-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  margin-top: 6px;
  color: var(--ink-soft);
  font-size: 0.9rem;
}

.row-meta > span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.meta-code {
  font-size: 0.75rem;
}

.detail-code {
  display: grid;
  gap: 10px;
}

.turn-detail-stack {
  gap: 14px;
}

.code-block {
  margin: 0;
  min-height: 180px;
  max-height: 320px;
  overflow: auto;
  padding: 14px;
  background: rgba(17, 17, 17, 0.94);
  color: #f7e7d6;
  border: 1px solid rgba(255, 255, 255, 0.04);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  font-family: var(--mono);
  font-size: 0.78rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.code-block--tall {
  min-height: 260px;
  max-height: 520px;
}

.config-form {
  display: grid;
  gap: 14px;
  margin-top: 16px;
}

.config-form label {
  display: grid;
  gap: 8px;
}

.config-form label > span {
  font-size: 0.92rem;
  color: var(--ink-soft);
}

.config-form input[type="text"],
.config-form select {
  width: 100%;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.74);
  min-height: 46px;
  padding: 0 14px;
  color: var(--ink);
}

.config-form input:focus,
.config-form select:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}

.toggle {
  grid-template-columns: auto 1fr;
  align-items: center;
}

.toggle input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}

.form-actions {
  align-items: center;
  margin-top: 6px;
}

.form-actions button {
  border: 0;
  background: var(--ink);
  color: #fff6eb;
  padding: 11px 18px;
  cursor: pointer;
  transition: transform 160ms ease, background-color 160ms ease;
}

.form-actions button:hover,
.form-actions button:focus-visible {
  transform: translateY(-2px);
  background: #2a231d;
  outline: none;
}

.runtime-block {
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}

.runtime-block:last-child {
  border-bottom: 0;
}

.runtime-block h4 {
  margin: 0 0 10px;
  font-size: 0.95rem;
}

.runtime-list {
  display: grid;
  gap: 8px;
}

.runtime-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  color: var(--ink-soft);
}

.runtime-item strong,
.runtime-item span {
  min-width: 0;
}

.runtime-item strong {
  flex: 0 0 auto;
}

.runtime-item span {
  flex: 1 1 auto;
  text-align: right;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.empty-state {
  padding: 16px 0;
  color: var(--ink-soft);
  font-size: 0.78rem;
  text-transform: uppercase;
}

@keyframes rise-in {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes live-pulse {
  0%, 100% {
    transform: scale(1);
    opacity: 0.9;
  }
  50% {
    transform: scale(1.45);
    opacity: 0.4;
  }
}

@media (max-width: 1120px) {
  .shell {
    grid-template-columns: 1fr;
  }

  .rail,
  .workspace {
    border-right: 0;
  }

  .rail {
    border-bottom: 1px solid rgba(255, 245, 231, 0.08);
  }

  .workspace {
    border-bottom: 1px solid var(--line);
  }
}

@media (max-width: 720px) {
  .rail,
  .workspace,
  .inspector {
    padding: 22px 18px 18px;
  }

  .workspace-head,
  .panel-head,
  .session-button,
  .run-row,
  .approval-row,
  .form-actions,
  .runtime-item {
    flex-direction: column;
    align-items: flex-start;
  }

  .workspace-meta {
    text-align: left;
  }

  .runtime-item span {
    text-align: left;
  }
}
`;

export const dashboardJs = `
const state = {
  overview: null,
  selectedSessionId: null,
  selectedRunId: null,
  configDirty: false,
  configHydrated: false,
};

const elements = {};

document.addEventListener('DOMContentLoaded', function () {
  elements.statsStrip = document.getElementById('stats-strip');
  elements.sessionList = document.getElementById('session-list');
  elements.sessionCount = document.getElementById('session-count');
  elements.workspaceTitle = document.getElementById('workspace-title');
  elements.selectedSummary = document.getElementById('selected-summary');
  elements.lastSync = document.getElementById('last-sync');
  elements.runList = document.getElementById('run-list');
  elements.approvalList = document.getElementById('approval-list');
  elements.turnDetailMeta = document.getElementById('turn-detail-meta');
  elements.turnInputJson = document.getElementById('turn-input-json');
  elements.turnRequestJson = document.getElementById('turn-request-json');
  elements.turnResponseJson = document.getElementById('turn-response-json');
  elements.runtimeMeta = document.getElementById('runtime-meta');
  elements.form = document.getElementById('config-form');
  elements.formStatus = document.getElementById('form-status');

  elements.form.addEventListener('input', function () {
    state.configDirty = true;
  });

  elements.form.addEventListener('submit', function (event) {
    event.preventDefault();
    void saveConfig();
  });

  void refreshOverview();
  window.setInterval(function () {
    void refreshOverview(true);
  }, 3000);
});

async function refreshOverview(isBackground) {
  try {
    const response = await fetch('/api/overview', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Failed to load operator data');
    }

    state.overview = await response.json();
    const sessions = state.overview.sessions || [];
    if (!state.selectedSessionId || !sessions.some(function (entry) { return entry.session.id === state.selectedSessionId; })) {
      state.selectedSessionId = sessions[0] ? sessions[0].session.id : null;
    }

    renderOverview();
  } catch (error) {
    if (!isBackground) {
      elements.lastSync.textContent = String(error);
    }
  }
}

async function saveConfig() {
  const payload = {
    botName: readField('botName'),
    aliases: readField('aliases').split(',').map(function (part) { return part.trim(); }).filter(Boolean),
    model: optionalField('model'),
    effort: optionalField('effort'),
    summary: readField('summary'),
    allowSelfMessages: elements.form.elements.namedItem('allowSelfMessages').checked,
  };

  elements.formStatus.textContent = 'Saving…';

  try {
    const response = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const problem = await response.json().catch(function () { return null; });
      throw new Error(problem && problem.error ? problem.error : 'Failed to save config');
    }

    const body = await response.json();
    state.overview.config = body.config;
    state.configDirty = false;
    state.configHydrated = false;
    hydrateConfigForm(body.config);
    renderRuntimeMeta(body.config);
    elements.formStatus.textContent = 'Saved to config file and applied to future turns.';
    window.setTimeout(function () {
      if (!state.configDirty) {
        elements.formStatus.textContent = '';
      }
    }, 2400);
  } catch (error) {
    elements.formStatus.textContent = String(error);
  }
}

function renderOverview() {
  const overview = state.overview;
  if (!overview) {
    return;
  }

  renderStats(overview.stats);
  renderSessions(overview.sessions);
  const filteredRuns = filterRunsForSelectedSession(overview.runs);
  syncSelectedRun(filteredRuns);
  renderRuns(filteredRuns);
  renderTurnDetail(filteredRuns);
  renderApprovals(overview.approvals);
  renderRuntimeMeta(overview.config);
  hydrateConfigForm(overview.config);

  elements.lastSync.textContent = 'Last sync ' + formatTime(overview.generatedAt);
}

function renderStats(stats) {
  elements.statsStrip.replaceChildren();
  [
    ['Sessions', String(stats.totalSessions)],
    ['Active runs', String(stats.activeRuns)],
    ['Pending approvals', String(stats.pendingApprovals)],
  ].forEach(function (entry) {
    const line = document.createElement('div');
    line.className = 'stat-line';
    const label = document.createElement('span');
    label.className = 'section-meta';
    label.textContent = entry[0];
    const value = document.createElement('strong');
    value.className = 'stat-value';
    value.textContent = entry[1];
    line.append(label, value);
    elements.statsStrip.appendChild(line);
  });
}

function renderSessions(entries) {
  elements.sessionList.replaceChildren();
  elements.sessionCount.textContent = entries.length + ' tracked';

  if (!entries.length) {
    elements.sessionList.appendChild(emptyState('No sessions recorded yet'));
    elements.workspaceTitle.textContent = 'Recent activity';
    elements.selectedSummary.textContent = 'Waiting for the first routed conversation';
    return;
  }

  const selected = entries.find(function (entry) { return entry.session.id === state.selectedSessionId; }) || entries[0];
  state.selectedSessionId = selected.session.id;
  elements.workspaceTitle.textContent = selected.session.displayName;
  elements.selectedSummary.textContent = [
    selected.session.channel,
    selected.session.externalChatId,
    selected.latestRun ? selected.latestRun.status : 'no runs yet',
  ].join(' • ');

  entries.forEach(function (entry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-button' + (entry.session.id === state.selectedSessionId ? ' is-active' : '');
    button.addEventListener('click', function () {
      state.selectedSessionId = entry.session.id;
      state.selectedRunId = null;
      renderOverview();
    });

    const main = document.createElement('div');
    main.className = 'session-main';

    const title = document.createElement('p');
    title.className = 'session-title';
    title.textContent = entry.session.displayName;

    const detail = document.createElement('p');
    detail.className = 'session-detail';
    detail.textContent = [
      entry.session.channel,
      entry.runCount + ' run' + (entry.runCount === 1 ? '' : 's'),
      entry.pendingApprovals ? entry.pendingApprovals + ' pending' : 'clear',
    ].join(' • ');

    main.append(title, detail);
    button.append(main, buildStatusPill(entry.latestRun ? entry.latestRun.status : 'idle', Boolean(entry.latestRun && isLiveStatus(entry.latestRun.status))));
    elements.sessionList.appendChild(button);
  });
}

function renderRuns(filtered) {
  elements.runList.replaceChildren();

  if (!filtered.length) {
    elements.runList.appendChild(emptyState('No runs for this session yet'));
    return;
  }

  filtered.slice(0, 12).forEach(function (entry, index) {
    const row = document.createElement('article');
    row.className = 'run-row' + (entry.run.id === state.selectedRunId ? ' is-active' : '');
    row.style.setProperty('--delay', String(index * 22) + 'ms');
    row.addEventListener('click', function () {
      state.selectedRunId = entry.run.id;
      renderOverview();
    });

    const main = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'row-title';
    title.textContent = entry.session.displayName;

    const detail = document.createElement('p');
    detail.className = 'run-detail';
    detail.textContent = entry.run.errorText || 'Turn ' + (entry.run.codexTurnId || 'pending') + ' on ' + entry.session.channel;

    const meta = document.createElement('div');
    meta.className = 'row-meta';
    meta.append(
      metaText('Started ' + formatTime(entry.run.startedAt)),
      metaText(entry.session.externalChatId),
      metaCode(entry.run.id)
    );

    main.append(title, detail, meta);
    row.append(main, buildStatusPill(entry.run.status, isLiveStatus(entry.run.status)));
    elements.runList.appendChild(row);
  });
}

function renderTurnDetail(filteredRuns) {
  if (!filteredRuns.length) {
    elements.turnDetailMeta.textContent = 'No run selected';
    elements.turnInputJson.textContent = 'No turn input recorded yet.';
    elements.turnRequestJson.textContent = 'No turn payload recorded yet.';
    elements.turnResponseJson.textContent = 'No turn response recorded yet.';
    return;
  }

  const selected = filteredRuns.find(function (entry) {
    return entry.run.id === state.selectedRunId;
  }) || filteredRuns[0];

  state.selectedRunId = selected.run.id;
  elements.turnDetailMeta.textContent = [
    selected.session.displayName,
    selected.run.status,
    selected.run.codexTurnId || selected.run.id,
  ].join(' • ');
  elements.turnInputJson.textContent = formatInputBlock(selected.run.codexRequestJson, 'Exact input array not captured for this run.');
  elements.turnRequestJson.textContent = formatJsonBlock(selected.run.codexRequestJson, 'Exact turn/start payload not captured for this run.');
  elements.turnResponseJson.textContent = formatJsonBlock(selected.run.codexResponseJson, 'Turn has not completed with a recorded result yet.');
}

function renderApprovals(entries) {
  elements.approvalList.replaceChildren();
  const filtered = entries.filter(function (entry) {
    return !state.selectedSessionId || (entry.session && entry.session.id === state.selectedSessionId);
  });

  if (!filtered.length) {
    elements.approvalList.appendChild(emptyState('No approvals for this session'));
    return;
  }

  filtered.slice(0, 10).forEach(function (entry) {
    const row = document.createElement('article');
    row.className = 'approval-row';

    const main = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'row-title';
    title.textContent = entry.approval.kind + ' • ' + (entry.session ? entry.session.displayName : 'orphaned run');

    const detail = document.createElement('p');
    detail.className = 'approval-detail';
    detail.textContent = entry.runStatus ? 'Run status ' + entry.runStatus : 'Awaiting operator decision';

    const meta = document.createElement('div');
    meta.className = 'row-meta';
    meta.append(
      metaCode(entry.approval.id),
      metaText(entry.approval.decidedAt ? 'Decided ' + formatTime(entry.approval.decidedAt) : 'Pending')
    );

    main.append(title, detail, meta);
    row.append(main, buildStatusPill(entry.approval.status, entry.approval.status === 'pending'));
    elements.approvalList.appendChild(row);
  });
}

function renderRuntimeMeta(config) {
  elements.runtimeMeta.replaceChildren();
  elements.runtimeMeta.append(
    runtimeBlock('Control surface', [
      runtimeItem(config.web.enabled ? 'Listening' : 'Disabled', config.web.host + ':' + String(config.web.port)),
    ]),
    runtimeBlock('Config path', [runtimeItem('File', config.path)]),
    runtimeBlock('Workspaces', config.workspaces.map(function (workspace) {
      return runtimeItem(workspace.id, workspace.cwd);
    })),
    runtimeBlock('Transports', config.transports.map(function (transport) {
      return runtimeItem(transport.id, transport.channel + ' • ' + transport.provider + ' • ' + (transport.enabled ? 'enabled' : 'disabled'));
    }))
  );
}

function filterRunsForSelectedSession(entries) {
  return entries.filter(function (entry) {
    return !state.selectedSessionId || entry.session.id === state.selectedSessionId;
  });
}

function syncSelectedRun(filteredRuns) {
  if (!filteredRuns.length) {
    state.selectedRunId = null;
    return;
  }

  if (!state.selectedRunId || !filteredRuns.some(function (entry) { return entry.run.id === state.selectedRunId; })) {
    state.selectedRunId = filteredRuns[0].run.id;
  }
}

function hydrateConfigForm(config) {
  if (state.configDirty && state.configHydrated) {
    return;
  }

  writeField('botName', config.editable.botName);
  writeField('aliases', config.editable.aliases.join(', '));
  writeField('model', config.editable.model || '');
  writeField('effort', config.editable.effort || '');
  writeField('summary', config.editable.summary);
  elements.form.elements.namedItem('allowSelfMessages').checked = config.editable.allowSelfMessages;
  state.configHydrated = true;
}

function buildStatusPill(status, isLive) {
  const pill = document.createElement('span');
  pill.className = 'status-pill status-' + sanitizeStatus(status) + (isLive ? ' is-live' : '');
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  const label = document.createElement('span');
  label.textContent = status;
  pill.append(dot, label);
  return pill;
}

function runtimeBlock(titleText, rows) {
  const section = document.createElement('section');
  section.className = 'runtime-block';
  const title = document.createElement('h4');
  title.textContent = titleText;
  const list = document.createElement('div');
  list.className = 'runtime-list';
  rows.forEach(function (row) { list.appendChild(row); });
  section.append(title, list);
  return section;
}

function runtimeItem(labelText, valueText) {
  const row = document.createElement('div');
  row.className = 'runtime-item';
  const label = document.createElement('strong');
  label.textContent = labelText;
  const value = document.createElement('span');
  value.textContent = valueText;
  row.append(label, value);
  return row;
}

function metaText(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function metaCode(text) {
  const span = document.createElement('span');
  span.className = 'meta-code';
  span.textContent = text;
  return span;
}

function emptyState(text) {
  const node = document.createElement('p');
  node.className = 'empty-state';
  node.textContent = text;
  return node;
}

function formatJsonBlock(jsonText, fallback) {
  if (!jsonText) {
    return fallback;
  }

  try {
    return JSON.stringify(JSON.parse(jsonText), null, 2);
  } catch (_error) {
    return jsonText;
  }
}

function formatInputBlock(jsonText, fallback) {
  if (!jsonText) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(jsonText);
    const input = parsed && typeof parsed === 'object' ? parsed.input : undefined;
    return JSON.stringify(input !== undefined ? input : parsed, null, 2);
  } catch (_error) {
    return jsonText;
  }
}

function sanitizeStatus(status) {
  return String(status).replace(/[^a-z_]/gi, '_');
}

function isLiveStatus(status) {
  return status === 'queued' || status === 'in_progress' || status === 'pending';
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    }).format(new Date(value));
  } catch (_error) {
    return value;
  }
}

function readField(name) {
  return String(elements.form.elements.namedItem(name).value || '');
}

function optionalField(name) {
  const value = readField(name).trim();
  return value || undefined;
}

function writeField(name, value) {
  elements.form.elements.namedItem(name).value = value;
}
`;
