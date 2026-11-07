// Static assets contain no environment values or API credentials.
export const dashboardHtml = `<!doctype html>
<html lang="en-GB">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>EdgeGuard · Operations</title>
    <link rel="stylesheet" href="/dashboard/style.css">
    <script src="/dashboard/app.js" defer></script>
</head>
<body>
    <header>
        <a href="/dashboard" class="brand">
            <span class="mark">E</span> EdgeGuard <small> / OPERATIONS</small>
        </a>
        <button id="logout" hidden>Sign out</button>
    </header>
    <main>
        <section id="login" class="login" hidden>
            <p class="eyebrow">RESTRICTED ACCESS</p>
            <h1>Sign in to EdgeGuard</h1>
            <p>Review events and manage incidents.</p>
            <form id="login-form">
                <label for="password">Dashboard password</label>
                <input id="password" type="password" autocomplete="current-password" required>
                <button class="primary">Sign in</button>
            </form>
        </section>

        <p id="message" role="status" aria-live="polite">Checking session…</p>

        <div id="app" hidden>
            <div class="heading">
                <div>
                    <p class="eyebrow">EDGE MONITORING</p>
                    <h1>Overview</h1>
                    <p>Event metrics and incident status.</p>
                </div>
                <button id="refresh">Refresh data ↻</button>
            </div>

            <p id="updated" class="muted"></p>

            <section id="metrics" class="metrics" aria-label="All-time metrics"></section>

            <section class="panel">
                <div class="section-heading">
                    <div>
                        <h2>Recent activity</h2>
                        <p>Events per hour · last 24 hours</p>
                    </div>
                    <span class="legend">● Events</span>
                </div>
                <div id="chart" class="chart" role="group" aria-label="Events per hour"></div>
                <p id="chart-summary" class="muted"></p>
            </section>

            <div class="workspace">
                <section class="panel incidents">
                    <div class="section-heading">
                        <div>
                            <h2>Incidents</h2>
                            <p>Up to 100 recent incidents matching your filters</p>
                        </div>
                    </div>
                    <div class="filters">
                        <label>Status
                            <select id="status">
                                <option value="">All</option>
                                <option value="open">Open</option>
                                <option value="resolved">Resolved</option>
                            </select>
                        </label>
                        <label>Severity
                            <select id="severity">
                                <option value="">All</option>
                                <option value="critical">Critical</option>
                                <option value="high">High</option>
                                <option value="medium">Medium</option>
                            </select>
                        </label>
                    </div>
                    <p id="list-status" role="status"></p>
                    <div class="table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th>Event</th>
                                    <th>Severity</th>
                                    <th>Status</th>
                                    <th>Date</th>
                                    <th><span class="sr-only">Details</span></th>
                                </tr>
                            </thead>
                            <tbody id="rows"></tbody>
                        </table>
                    </div>
                </section>

                <section id="detail" class="panel detail" aria-label="Incident analysis" tabindex="-1">
                    <p class="eyebrow">INVESTIGATION</p>
                    <h2>Select an incident</h2>
                    <p>View the detection rule, event details and analysis.</p>
                </section>
            </div>

            <footer>EdgeGuard · Rule-based detection · All-time metrics in D1</footer>
        </div>
    </main>
</body>
</html>`;

export const dashboardStyle = `
:root {
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    color: #dfe8f1;
    background: #0b1017;
    color-scheme: dark;
    font-size: 14px;
}

* {
    box-sizing: border-box;
}

body {
    margin: 0;
}

header {
    height: 78px;
    padding: 0 5%;
    border-bottom: 1px solid #26303d;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #0e151e;
}

.brand {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 20px;
    font-weight: 700;
    text-decoration: none;
    color: inherit;
}

.brand small {
    font-size: 10px;
    letter-spacing: 2px;
    color: #8b9aac;
}

.mark {
    background: #bef264;
    color: #16220b;
    padding: 6px 11px;
    border-radius: 9px;
}

main {
    max-width: 1440px;
    margin: auto;
    padding: 38px 5%;
}

h1 {
    font-size: 36px;
    letter-spacing: -1.3px;
    margin: 8px 0;
}

h2 {
    font-size: 18px;
    margin: 0 0 8px;
}

p {
    color: #93a4b7;
    line-height: 1.6;
}

.eyebrow {
    font-size: 10px;
    letter-spacing: 2px;
    font-weight: 700;
    color: #bef264;
}

.heading,
.section-heading {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
}

.heading p {
    margin: 8px 0;
}

.heading {
    margin-bottom: 20px;
}

button,
input,
select {
    font: inherit;
    border: 1px solid #354255;
    border-radius: 7px;
    padding: 10px 13px;
    background: #172230;
    color: inherit;
}

button {
    cursor: pointer;
    font-weight: 600;
}

button:hover {
    background: #253648;
}

button:disabled {
    opacity: 0.5;
    cursor: wait;
}

:focus-visible {
    outline: 2px solid #bef264;
    outline-offset: 4px;
}

.primary {
    background: #bef264;
    color: #1b2b0a;
    border-color: #bef264;
}

.primary:hover {
    background: #d2ff8a;
}

.metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin: 20px 0;
}

.metric,
.panel {
    background: #111a25;
    border: 1px solid #273444;
    border-radius: 12px;
    padding: 24px;
}

.metric strong {
    display: block;
    font-size: 31px;
    letter-spacing: -1px;
    margin: 15px 0 6px;
}

.metric small,
.muted {
    color: #93a4b7;
    font-size: 12px;
}

.metric p {
    margin: 0;
}

.panel {
    margin-bottom: 20px;
}

.section-heading p {
    margin: 0;
    font-size: 12px;
}

.legend {
    color: #bef264;
    font-size: 12px;
}

.chart {
    height: 115px;
    display: flex;
    align-items: end;
    gap: 5px;
    margin-top: 25px;
    border-bottom: 1px solid #344253;
}

.bar {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: end;
}

.bar svg { width: 100%; height: 100%; fill: #bef264; }

.workspace {
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(290px, 1fr);
    gap: 20px;
}

.filters {
    display: flex;
    gap: 12px;
    margin: 20px 0;
}

label {
    display: grid;
    gap: 7px;
    color: #a5b4c5;
    font-size: 12px;
}

select {
    min-width: 130px;
}

.table-wrap {
    overflow: auto;
}

table {
    border-collapse: collapse;
    width: 100%;
    text-align: left;
    font-size: 12px;
}

th {
    font-size: 10px;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #93a4b7;
    font-weight: 500;
}

td,
th {
    padding: 14px 8px;
    border-bottom: 1px solid #253141;
}

td:first-child {
    max-width: 230px;
    overflow-wrap: anywhere;
}

td button {
    padding: 7px 9px;
}

.badge {
    display: inline-block;
    padding: 4px 7px;
    border-radius: 5px;
    font-size: 11px;
    background: #253449;
}

.critical {
    color: #ffb1ad;
    background: #42282f;
}

.high {
    color: #ffd09b;
    background: #423326;
}

.medium {
    color: #d0c0ff;
    background: #312a47;
}

.resolved {
    color: #bef264;
    background: #293924;
}

.detail {
    align-self: start;
    overflow-wrap: anywhere;
}

.detail h3 {
    font-size: 13px;
    margin-top: 25px;
}

.detail dl {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    font-size: 12px;
}

.detail dt {
    color: #93a4b7;
}

.detail dd {
    margin: 0;
}

.notice {
    border-left: 2px solid #73849b;
    padding-left: 13px;
    font-size: 12px;
}

footer {
    color: #718397;
    font-size: 11px;
    padding: 15px 0;
}

.login {
    max-width: 440px;
    margin: 60px auto;
}

.login form {
    display: grid;
    gap: 15px;
    margin-top: 30px;
}

.login h1 {
    font-size: 40px;
}

.login input {
    width: 100%;
}

#message:empty {
    display: none;
}

#message {
    color: #ffd09b;
}

.sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
}

[hidden] {
    display: none !important;
}

@media(max-width: 1050px) {
    .workspace {
        grid-template-columns: 1fr;
    }
    .metrics {
        grid-template-columns: repeat(2, 1fr);
    }
}

@media(max-width: 560px) {
    main {
        padding: 24px 16px;
    }
    .brand small {
        display: none;
    }
    .heading {
        align-items: start;
    }
    .heading h1 {
        font-size: 29px;
    }
    .heading button {
        font-size: 12px;
    }
    .metric,
    .panel {
        padding: 17px;
    }
    .metric strong {
        font-size: 27px;
    }
    .filters {
        flex-wrap: wrap;
    }
    .chart {
        gap: 2px;
    }
}
`;

export const dashboardScript = String.raw`
const $ = id => document.getElementById(id);

const labels = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    open: 'Open',
    resolved: 'Resolved'
};

let incidents = [],
    selected = null,
    generation = 0;

const number = value => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value);
const date = value => new Date(value).toLocaleString('en-GB');

function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
}

function message(text = '') {
    $('message').textContent = text;
}

function session(active) {
    $('login').hidden = active;
    $('app').hidden = !active;
    $('logout').hidden = !active;

    if (!active) {
        generation++;
        incidents = [];
        selected = null;
        $('rows').replaceChildren();
        $('metrics').replaceChildren();
        $('chart').replaceChildren();
        $('detail').replaceChildren(el('h2', 'Select an incident'), el('p', 'Choose View in the incidents table to see the detection rule and event details.'));
    }
}

async function api(path, options = {}) {
    const response = await fetch('/dashboard/' + path, {
        credentials: 'same-origin',
        ...options,
        headers: { 'Content-Type': 'application/json' }
    });

    const result = await response.json();

    if (!response.ok) {
        if (response.status === 401) session(false);
        throw new Error(result.error || 'Request failed.');
    }

    return result.data ?? result;
}

function badge(value) {
    return el('span', labels[value], 'badge ' + value);
}

function detail(item) {
    selected = item.id;
    const panel = $('detail');

    panel.replaceChildren(
        el('p', 'INVESTIGATION', 'eyebrow'),
        el('h2', item.eventMethod + ' ' + item.eventPath),
        badge(item.severity)
    );

    const dl = el('dl');
    [
        ['Status', labels[item.status]],
        ['HTTP response', item.eventStatus],
        ['Latency', number(item.eventLatencyMs) + ' ms'],
        ['Event', date(item.eventOccurredAt)],
        ['Incident', item.id]
    ].forEach(([k, v]) => dl.append(el('dt', k), el('dd', v)));

    panel.append(
        dl,
        el('h3', 'Rule analysis'),
        el('p', item.reason),
        el('h3', 'AI analysis'),
        el('p', ({not_requested: 'Not requested.', pending: 'Pending.', running: 'In progress. Refresh to check.', failed: 'Analysis failed. The rule-created incident is preserved.', complete: 'Complete.'})[item.analysisState], 'notice')
    );

    if (item.analysis) {
        panel.append(el('p', item.analysis.summary));
        for (const [heading, values] of [['Possible causes (hypotheses)', item.analysis.possibleCauses], ['Suggested next steps', item.analysis.suggestedNextSteps]]) {
            const list = el('ul');
            for (const value of values) list.append(el('li', value));
            panel.append(el('h3', heading), list);
        }
    }
    if (item.analysisState === 'failed') {
        const retry = el('button', 'Retry analysis');
        retry.onclick = async () => {
            retry.disabled = true;
            try {
                await api('api/incidents/' + encodeURIComponent(item.id) + '/analysis/retry', {method: 'POST'});
                await loadIncidents();
            } catch (error) {
                message(error.message);
            } finally {
                retry.disabled = false;
            }
        };
        panel.append(retry);
    }

    const button = el('button', item.status === 'open' ? 'Mark as resolved' : 'Reopen incident', 'primary');

    button.addEventListener('click', async () => {
        button.disabled = true;
        message();

        try {
            const updated = await api('api/incidents/' + encodeURIComponent(item.id), {
                method: 'PATCH',
                body: JSON.stringify({ status: item.status === 'open' ? 'resolved' : 'open' })
            });

            detail(updated);
            await refresh();
            message('Status updated.');
        } catch (error) {
            message(error.message);
        } finally {
            button.disabled = false;
        }
    });

    panel.append(button);
}

async function loadIncidents() {
    const version = ++generation;
    $('list-status').textContent = 'Loading incidents…';

    const query = new URLSearchParams({ limit: '100' });
    for (const name of ['status', 'severity']) {
        if ($(name).value) query.set(name, $(name).value);
    }

    try {
        const items = await api('api/incidents?' + query);
        if (version !== generation) return;

        incidents = items;
        $('rows').replaceChildren();

        for (const item of items) {
            const tr = el('tr');
            const endpoint = el('td', item.eventMethod + ' ' + item.eventPath);
            const severity = el('td');
            severity.append(badge(item.severity));
            const status = el('td');
            status.append(badge(item.status));

            const action = el('td');
            const button = el('button', 'View');
            button.setAttribute('aria-label', 'View incident ' + item.id);
            button.onclick = () => {
                detail(item);
                $('detail').focus();
            };
            action.append(button);

            tr.append(endpoint, severity, status, el('td', date(item.createdAt)), action);
            $('rows').append(tr);
        }

        $('list-status').textContent = items.length ? items.length + (items.length === 1 ? ' matching incident.' : ' matching incidents.') : 'No incidents match these filters.';

        if (selected) {
            const item = items.find(i => i.id === selected);
            if (item) {
                detail(item);
            } else {
                selected = null;
                $('detail').replaceChildren(
                    el('h2', 'Select an incident'),
                    el('p', 'The selected incident no longer matches this list.')
                );
            }
        }
    } catch (error) {
        if (version !== generation) return;
        $('rows').replaceChildren();
        $('list-status').textContent = 'Could not load incidents.';
        throw error;
    }
}

async function metrics() {
    try {
        const data = await api('api/metrics');
        $('metrics').replaceChildren();

        const metricList = [
            ['Events received', number(data.events.total), 'All time'],
            ['Open incidents', number(data.incidents.open), number(data.incidents.resolved) + ' resolved · ' + number(data.incidents.total) + ' total'],
            ['Server errors', number(data.events.serverErrors), number(data.events.rateLimitedResponses) + ' HTTP 429 responses'],
            ['Average latency', number(data.events.averageLatencyMs) + ' ms', number(data.incidents.bySeverity.critical) + ' critical incidents']
        ];

        for (const [name, value, note] of metricList) {
            const card = el('article', undefined, 'metric');
            card.append(el('p', name), el('strong', value), el('small', note));
            $('metrics').append(card);
        }
    } catch (error) {
        $('metrics').replaceChildren(el('p', 'Metrics unavailable.'));
        throw error;
    }
}

async function chart() {
    try {
        const data = await api('api/metrics/timeseries?hours=24');
        $('chart').replaceChildren();
        const max = Math.max(1, ...data.points.map(p => p.total));

        for (const point of data.points) {
            const title = date(point.timestamp) + ': ' + number(point.total) + ' events, ' + number(point.serverErrors) + ' 5xx errors';
            const bar = el('div', undefined, 'bar');

            bar.title = title;
            bar.setAttribute('role', 'img');
            bar.setAttribute('aria-label', title);
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 1 100');
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.setAttribute('aria-hidden', 'true');
            const rect = document.createElementNS(svg.namespaceURI, 'rect');
            const height = 100 * point.total / max;
            rect.setAttribute('width', '1');
            rect.setAttribute('height', String(height));
            rect.setAttribute('y', String(100 - height));
            svg.append(rect);
            bar.append(svg);
            $('chart').append(bar);
        }

        $('chart-summary').textContent = date(data.points[0].timestamp) + ' — ' + date(data.points.at(-1).timestamp) + ' · ' + number(data.points.reduce((sum, p) => sum + p.total, 0)) + ' events';
    } catch (error) {
        $('chart').replaceChildren();
        $('chart-summary').textContent = 'Activity unavailable.';
        throw error;
    }
}

async function refresh() {
    $('refresh').disabled = true;
    message();

    const results = await Promise.allSettled([metrics(), chart(), loadIncidents()]);
    const errors = results.filter(r => r.status === 'rejected');

    $('updated').textContent = errors.length ? 'Refresh incomplete. Try again.' : 'Updated at ' + new Date().toLocaleTimeString('en-GB');

    if (errors.length) {
        message(errors.map(r => r.reason.message).join(' '));
    }

    $('refresh').disabled = false;
}

$('login-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    message();

    try {
        await api('login', {
            method: 'POST',
            body: JSON.stringify({ password: $('password').value })
        });

        $('password').value = '';
        session(true);
        await refresh();
    } catch (error) {
        message(error.message);
    } finally {
        button.disabled = false;
    }
};

$('logout').onclick = async () => {
    try {
        await api('logout', { method: 'POST' });
        session(false);
        message('Signed out.');
    } catch (error) {
        message(error.message);
    }
};

$('refresh').onclick = refresh;

for (const name of ['status', 'severity']) {
    $(name).onchange = () => loadIncidents().catch(error => message(error.message));
}

(async () => {
    try {
        await api('session');
        session(true);
        await refresh();
    } catch (error) {
        session(false);
        message(error.message);
    }
})();
`;
