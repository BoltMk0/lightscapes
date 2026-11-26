// The hub's page: where it connects, what it's following, and what lights and buttons it has.

const $ = selector => document.querySelector(selector);

/** @param {string} tag @param {Record<string, string>} [attrs] @param {(Node|string)[]} [children] */
function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.append(...children);
    return node;
}

async function api(path, init = {}) {
    const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
    return body;
}

let toastTimer;
function toast(text) {
    const node = $('#toast');
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.hidden = true, 3000);
}

// --- Pages ---

function showPage() {
    const page = location.hash.slice(1) || 'connection';
    for (const node of document.querySelectorAll('.page')) node.hidden = node.dataset.page !== page;
    for (const link of document.querySelectorAll('#nav a')) link.classList.toggle('active', link.dataset.page === page);
    if (page === 'lights') loadLights();
}
addEventListener('hashchange', showPage);

// --- Status ---

const APP_STATES = {
    unconfigured: ['warn', 'Not set up', 'Enter the app\'s address below.'],
    connecting: ['warn', 'Connecting', 'Connecting to the app…'],
    pending: ['warn', 'Waiting for approval', 'Waiting to be approved. In Clockmaker, approve it in Settings → Lightscapes.'],
    accepted: ['ok', 'Connected', 'Connected to the app.'],
    rejected: ['bad', 'Turned away', 'The app turned this hub away.'],
    error: ['bad', 'Can\'t connect', 'Can\'t connect to the app.']
};

let formFilled = false;

function chip(kind, text, title = '') {
    return el('span', { class: `chip ${kind}`, title }, [text]);
}

function renderStatus(status) {
    $('#hub-name').textContent = status.hub.name;
    document.title = `${status.hub.name} · Lightscapes`;

    const [kind, label, sentence] = APP_STATES[status.app.state];
    const chips = [chip(kind, `App: ${label}`, status.app.error ?? '')];
    for (const adapter of status.adapters) chips.push(chip(adapter.ok ? 'ok' : 'bad', adapter.name, adapter.detail ?? ''));
    if (status.dryRun) chips.push(chip('warn', 'Dry run', 'The lights are logged, not set'));
    $('#status').replaceChildren(...chips);

    const state = $('#app-state');
    state.textContent = status.app.error && status.app.state !== 'connecting' ? `${sentence} ${status.app.error}` : sentence;
    state.className = `message${kind === 'bad' ? ' error' : ''}`;
    $('#retry').hidden = status.app.state !== 'rejected';

    $('#following').textContent = status.following
        ? `${status.following.name}. The lights show what the app asks for.`
        : 'Nothing: the lights are left as they are, and buttons do nothing. Pick this hub for a game in the app.';

    if (!formFilled) {
        const form = $('#settings');
        form.url.value = status.app.url;
        form.name.value = status.hub.name;
        formFilled = true;
    }

    $('#activity').replaceChildren(...status.activity.map(a => el('li', {}, [
        el('time', { datetime: new Date(a.at).toISOString() }, [new Date(a.at).toLocaleTimeString()]),
        ' ', a.text
    ])));
    if (status.activity.length === 0) $('#activity').replaceChildren(el('li', { class: 'empty' }, ['Nothing yet.']));
}

async function poll() {
    try {
        renderStatus(await api('/api/status'));
    } catch (err) {
        $('#status').replaceChildren(chip('bad', 'Hub unreachable', err.message));
    }
}

$('#settings').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    try {
        renderStatus(await api('/api/settings', { method: 'PUT', body: JSON.stringify({ url: form.url.value, name: form.name.value }) }));
        toast('Saved');
    } catch (err) {
        toast(err.message);
    }
});

$('#retry').addEventListener('click', async () => {
    try {
        renderStatus(await api('/api/retry', { method: 'POST' }));
    } catch (err) {
        toast(err.message);
    }
});

// --- Lights & buttons ---

function stateText(state) {
    if (!state) return '';
    const parts = [];
    if (state.on !== null) parts.push(state.on ? 'On' : 'Off');
    if (state.on && state.brightness !== undefined) parts.push(`${Math.round(state.brightness * 100)}%`);
    if (state.on && state.color?.kind === 'white') parts.push(`${state.color.kelvin}K`);
    if (state.on && state.color?.kind === 'rgb') parts.push(state.color.hex);
    if (state.source === 'assumed' && parts.length) parts.push('(assumed)');
    return parts.join(' ');
}

function capsText(caps) {
    return [
        caps.color && 'colour',
        caps.white && `white ${caps.white.minKelvin}–${caps.white.maxKelvin}K`,
        caps.brightness && 'dims',
        caps.effects.length && 'effects'
    ].filter(Boolean).join(', ') || 'on/off';
}

async function loadLights() {
    try {
        const { lights, inputs, states } = await api('/api/lights');
        $('#lights').replaceChildren(
            el('tr', {}, ['Name', 'Kind', 'Can do', 'Now', 'Reachable'].map(h => el('th', {}, [h]))),
            ...lights.map(light => {
                const state = states[light.id];
                return el('tr', {}, [
                    el('td', { title: light.description ?? '' }, [light.name]),
                    el('td', {}, [light.kind === 'group' ? `Group of ${light.members?.length ?? 0}` : 'Light']),
                    el('td', {}, [capsText(light.caps)]),
                    el('td', {}, [stateText(state)]),
                    el('td', {}, [state?.reachable === true ? 'Yes' : state?.reachable === false ? 'No' : ''])
                ]);
            })
        );
        if (lights.length === 0) $('#lights').replaceChildren(el('tr', {}, [el('td', { class: 'empty' }, ['No lights yet.'])]));
        $('#inputs').replaceChildren(
            el('tr', {}, ['Name', 'Actions'].map(h => el('th', {}, [h]))),
            ...inputs.map(input => el('tr', {}, [
                el('td', { title: input.description ?? '' }, [input.name]),
                el('td', {}, [input.actions?.join(', ') || 'Not listed'])
            ]))
        );
        if (inputs.length === 0) $('#inputs').replaceChildren(el('tr', {}, [el('td', { class: 'empty' }, ['No buttons yet.'])]));
    } catch (err) {
        toast(err.message);
    }
}

showPage();
poll();
setInterval(poll, 2000);
