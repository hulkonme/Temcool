'use strict';

/* ------------------------------------------------------------------
   Temcool frontend
   Talks only to the local /api endpoints; the server owns the mailbox.
------------------------------------------------------------------- */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const POLL_MS = 8000;
const BASE_TITLE = 'Temcool — Free Temporary Email Address';
const THEME_KEY = 'temcool.theme';
const IMAGES_KEY = 'temcool.images';
const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const state = {
  address: '',
  domains: [],
  expiresAt: 0,
  createdAt: 0,
  messages: [],
  current: null,
  view: 'html',
  showImages: localStorage.getItem(IMAGES_KEY) === '1',
  timer: null,
  poller: null,
  loadingMessages: false,
  expiredNotified: false,
  lastFocused: null,
};

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`/api${path}`, init);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const error = new Error(data?.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data || {};
}

function toast(message, type = 'info', icon = 'i-check') {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<svg class="icon"><use href="#${icon}"/></svg><span></span>`;
  el.querySelector('span').textContent = message;
  root.append(el);
  window.setTimeout(() => {
    el.classList.add('leaving');
    window.setTimeout(() => el.remove(), 220);
  }, 3400);
}

async function copyAddress(text = state.address) {
  if (!text) return;
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
  }
  if (copied) toast('Address copied to clipboard', 'success', 'i-copy');
  else toast('Could not copy — select the address manually', 'error', 'i-alert');
}

function addressOf(from) {
  return (from && from.address) || '';
}

function displayName(from) {
  if (!from) return 'Unknown sender';
  const name = (from.name || '').trim();
  if (name) return name;
  return addressOf(from) || 'Unknown sender';
}

function formatSender(from) {
  const name = (from?.name || '').trim();
  const address = addressOf(from);
  if (name && address) return `${name} · ${address}`;
  return name || address || 'Unknown sender';
}

function initials(from) {
  const source = (from?.name || '').trim() || addressOf(from);
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (source[0] || '?').toUpperCase();
}

const PALETTES = [
  ['#5eead4', '#818cf8'],
  ['#fbbf24', '#fb7185'],
  ['#60a5fa', '#a78bfa'],
  ['#34d399', '#22d3ee'],
  ['#f472b6', '#f59e0b'],
  ['#a3e635', '#14b8a6'],
  ['#c084fc', '#60a5fa'],
];

function avatarGradient(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTES[hash % PALETTES.length];
}

function timeAgo(iso) {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setFormHint(text, isError = false) {
  const el = $('#formHint');
  const message = text || 'Letters, numbers, dots, dashes. 1–32 characters.';
  el.textContent = message;
  el.classList.toggle('error', isError && Boolean(text));
}

function setOffline(offline) {
  $('#liveState').classList.toggle('offline', offline);
  $('#liveText').textContent = offline ? 'Offline' : 'Watching';
  $('#liveState').title = offline
    ? 'Cannot reach the mail service right now'
    : 'Auto-refreshing every 8 seconds';
}

/* ------------------------------------------------------------------ */
/* theme                                                               */
/* ------------------------------------------------------------------ */

function initTheme() {
  let theme = localStorage.getItem(THEME_KEY);
  if (theme !== 'dark' && theme !== 'light') {
    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'light' ? '#eef2f9' : '#060a12'
  );
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    next === 'light' ? '#eef2f9' : '#060a12'
  );
}

/* ------------------------------------------------------------------ */
/* address + timer                                                     */
/* ------------------------------------------------------------------ */

function setInbox(info) {
  state.address = info.address || '';
  state.expiresAt = Number(info.expiresAt) || 0;
  state.createdAt = Number(info.createdAt) || Date.now();
  if (Array.isArray(info.domains) && info.domains.length) state.domains = info.domains;
  state.expiredNotified = false;

  $('#addressText').textContent = state.address || 'loading…';
  $('#emptyAddress').textContent = state.address || 'your address';
  renderDomainOptions();
  startTimer();
  setOffline(false);
}

function renderDomainOptions() {
  const select = $('#domainSelect');
  const current = state.address.split('@')[1] || select.value;
  if (!state.domains.length) return;

  select.replaceChildren(
    ...state.domains.map((domain) => {
      const option = document.createElement('option');
      option.value = domain;
      option.textContent = domain;
      return option;
    })
  );

  if (state.domains.includes(current)) select.value = current;
}

function startTimer() {
  window.clearInterval(state.timer);
  updateTimer();
  state.timer = window.setInterval(updateTimer, 1000);
}

function updateTimer() {
  const label = $('#timerText');
  const pill = $('#timerPill');

  if (!state.expiresAt) {
    label.textContent = '--:--';
    return;
  }

  const left = state.expiresAt - Date.now();
  if (left <= 0) {
    label.textContent = 'expired';
    pill.classList.add('expiring');
    if (!state.expiredNotified) {
      state.expiredNotified = true;
      toast('Inbox timer expired — extend it or create a new address', 'error', 'i-clock');
    }
  } else {
    pill.classList.remove('expiring');
    const total = Math.ceil(left / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    label.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  if (state.createdAt) {
    const ageMinutes = Math.floor((Date.now() - state.createdAt) / 60000);
    $('#createdPill').textContent = ageMinutes < 1 ? 'created just now' : `created ${ageMinutes}m ago`;
  }
}

/* ------------------------------------------------------------------ */
/* inbox creation                                                      */
/* ------------------------------------------------------------------ */

async function createInbox(body = {}, { quiet = false } = {}) {
  const newButton = $('#newBtn');
  const previousDisabled = newButton.disabled;
  newButton.disabled = true;

  try {
    const info = await api('/inbox', { method: 'POST', body });
    setInbox(info);

    state.messages = [];
    state.current = null;
    if (!$('#reader').hidden) closeReader();

    $('#loading').hidden = false;
    $('#empty').hidden = true;
    $('#errorState').hidden = true;
    $('#msgList').replaceChildren();
    $('#unreadCount').hidden = true;
    updateTitle();

    if (!quiet) toast('Fresh address ready', 'success', 'i-check');

    await loadMessages({ silent: true });
    return info;
  } catch (error) {
    if (!quiet) toast(error.message, 'error', 'i-alert');
    throw error;
  } finally {
    newButton.disabled = previousDisabled;
    $('#customForm button[type="submit"]').disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* messages                                                            */
/* ------------------------------------------------------------------ */

function updateCount() {
  const unread = state.messages.filter((message) => !message.seen).length;
  const chip = $('#unreadCount');
  chip.textContent = String(unread);
  chip.hidden = unread === 0;
}

function updateTitle() {
  const unread = state.messages.filter((message) => !message.seen).length;
  document.title = unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
}

function renderMessages() {
  const list = $('#msgList');
  const empty = $('#empty');
  const error = $('#errorState');

  $('#loading').hidden = true;
  error.hidden = true;

  if (!state.messages.length) {
    list.replaceChildren();
    empty.hidden = false;
    updateCount();
    updateTitle();
    return;
  }

  empty.hidden = true;
  list.replaceChildren(...state.messages.map(createRow));
  updateCount();
  updateTitle();
}

function createRow(message) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `msg${message.seen ? '' : ' unread'}`;
  button.setAttribute(
    'aria-label',
    `Open message "${message.subject || 'no subject'}" from ${displayName(message.from)}`
  );
  button.addEventListener('click', () => openMessage(message.id));

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = initials(message.from);
  const [from, to] = avatarGradient(addressOf(message.from) || displayName(message.from));
  avatar.style.background = `linear-gradient(135deg, ${from}, ${to})`;

  const main = document.createElement('div');
  main.className = 'msg-main';

  const top = document.createElement('div');
  top.className = 'msg-top';

  const sender = document.createElement('span');
  sender.className = 'msg-from';
  sender.textContent = displayName(message.from);
  sender.title = addressOf(message.from);
  top.append(sender);

  const subject = document.createElement('p');
  subject.className = 'msg-subject';
  subject.textContent = message.subject || '(no subject)';

  const preview = document.createElement('p');
  preview.className = 'msg-preview';
  preview.textContent = message.intro || 'No preview available.';

  main.append(top, subject, preview);

  const side = document.createElement('div');
  side.className = 'msg-side';

  const when = document.createElement('span');
  when.className = 'msg-time';
  when.textContent = timeAgo(message.createdAt);
  when.title = formatDate(message.createdAt);
  side.append(when);

  if (message.hasAttachments) {
    side.insertAdjacentHTML(
      'beforeend',
      '<svg class="icon" aria-label="Has attachment"><use href="#i-paperclip"/></svg>'
    );
  }

  button.append(avatar, main, side);
  item.append(button);
  return item;
}

async function loadMessages({ silent = false } = {}) {
  if (state.loadingMessages) return;
  state.loadingMessages = true;

  const previousIds = new Set(state.messages.map((message) => message.id));
  const hadMessages = state.messages.length > 0;

  try {
    const data = await api('/messages');
    const messages = Array.isArray(data.messages) ? data.messages : [];

    state.messages = messages;
    setOffline(false);
    renderMessages();

    if (!silent && hadMessages) {
      const fresh = messages.filter((message) => !previousIds.has(message.id) && !message.seen);
      if (fresh.length) {
        const who = displayName(fresh[0].from);
        toast(`New email from ${who}`, 'success', 'i-mail');
      }
    }
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      state.loadingMessages = false;
      try {
        await createInbox({}, { quiet: true });
      } catch (createError) {
        showError(createError.message);
      }
      return;
    }

    setOffline(true);
    if (silent) {
      if (error.status === 429) toast(error.message, 'error', 'i-alert');
    } else {
      showError(error.message);
    }
  } finally {
    state.loadingMessages = false;
  }
}

function showError(message) {
  $('#loading').hidden = true;
  $('#empty').hidden = true;
  $('#msgList').replaceChildren();
  $('#errorState').hidden = false;
  $('#errorText').textContent = message || 'Something went wrong.';
  setOffline(true);
}

async function manualRefresh() {
  const button = $('#refreshBtn');
  button.classList.add('spinning');
  window.setTimeout(() => button.classList.remove('spinning'), 700);
  await loadMessages({ silent: false });
}

function startPolling() {
  window.clearInterval(state.poller);
  state.poller = window.setInterval(() => {
    if (document.hidden || !state.address) return;
    loadMessages({ silent: true });
  }, POLL_MS);
}

/* ------------------------------------------------------------------ */
/* reader                                                              */
/* ------------------------------------------------------------------ */

function syncSegmented() {
  $$('.seg-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
  });
}

function renderReaderHeader(message) {
  $('#readerSubject').textContent = message.subject || '(no subject)';
  $('#readerFrom').textContent = formatSender(message.from);
  $('#readerTime').textContent = formatDate(message.createdAt);

  const avatar = $('#readerAvatar');
  avatar.textContent = initials(message.from);
  const [from, to] = avatarGradient(addressOf(message.from) || displayName(message.from));
  avatar.style.background = `linear-gradient(135deg, ${from}, ${to})`;
}

function prepareHtml(raw) {
  const doc = new DOMParser().parseFromString(raw, 'text/html');

  doc.querySelectorAll('script, iframe, object, embed, link, meta, base, form, input, button').forEach((el) => {
    el.remove();
  });

  doc.querySelectorAll('*').forEach((el) => {
    Array.from(el.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attribute.name);
      if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^\s*javascript:/i.test(attribute.value)
      ) {
        el.removeAttribute(attribute.name);
      }
    });

    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });

  if (!state.showImages) {
    doc.querySelectorAll('img').forEach((img) => {
      img.setAttribute('src', TRANSPARENT_GIF);
      img.removeAttribute('srcset');
    });
  }

  const base = doc.createElement('base');
  base.setAttribute('target', '_blank');
  doc.head.prepend(base);

  const style = doc.createElement('style');
  style.textContent = `
    html, body { margin: 0; padding: 0; }
    body {
      padding: 22px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.62;
      color: #111827;
      overflow-wrap: anywhere;
    }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
    a { color: #0d9488; }
    pre { white-space: pre-wrap; }
  `;
  doc.head.append(style);

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

function htmlToText(raw) {
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  return (doc.body?.innerText || '').trim();
}

function renderReaderBody() {
  const body = $('#readerBody');
  const message = state.current;
  body.replaceChildren();
  if (!message) return;

  if (state.view === 'html' && message.html && message.html.trim()) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'Email content');
    frame.srcdoc = prepareHtml(message.html);
    body.append(frame);
    return;
  }

  const pre = document.createElement('pre');
  let text = message.text || '';
  if (!text && message.html) text = htmlToText(message.html);
  pre.textContent = text || 'This message has no readable content.';
  body.append(pre);
}

function renderAttachments(message) {
  const wrap = $('#readerAttach');
  wrap.replaceChildren();
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  if (!attachments.length) {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  const label = document.createElement('span');
  label.className = 'attach-label';
  label.textContent = `Attachments (${attachments.length})`;
  wrap.append(label);

  for (const attachment of attachments) {
    const link = document.createElement('a');
    link.className = 'attach';
    link.href = `/api/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}`;
    link.setAttribute('download', attachment.filename || 'attachment');
    link.insertAdjacentHTML('beforeend', '<svg class="icon"><use href="#i-paperclip"/></svg>');

    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = attachment.filename || 'attachment';

    const size = document.createElement('span');
    size.className = 'attach-size';
    size.textContent = formatBytes(attachment.size);

    link.append(name, size);
    wrap.append(link);
  }
}

async function openMessage(id) {
  const reader = $('#reader');
  const body = $('#readerBody');
  const attach = $('#readerAttach');

  state.lastFocused = document.activeElement;
  state.current = null;
  state.view = 'html';
  syncSegmented();
  $('#imagesToggle').checked = state.showImages;

  $('#readerSubject').textContent = 'Loading message…';
  $('#readerFrom').textContent = '';
  $('#readerTime').textContent = '';
  $('#readerAvatar').textContent = '…';
  $('#readerAvatar').style.background = 'var(--panel-2)';

  body.replaceChildren();
  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.textContent = 'Opening message…';
  body.append(placeholder);
  attach.hidden = true;

  reader.hidden = false;
  document.body.style.overflow = 'hidden';
  $('.reader-close').focus();

  try {
    const message = await api(`/messages/${encodeURIComponent(id)}`);
    state.current = message;
    renderReaderHeader(message);
    renderReaderBody();
    renderAttachments(message);

    const rowIndex = state.messages.findIndex((item) => item.id === id);
    const row = rowIndex >= 0 ? state.messages[rowIndex] : null;
    if (row && !row.seen) {
      row.seen = true;
      const button = $('#msgList').children[rowIndex]?.querySelector('.msg');
      button?.classList.remove('unread');
      updateCount();
      updateTitle();
    }
  } catch (error) {
    $('#readerSubject').textContent = 'Could not open message';
    $('#readerFrom').textContent = '';
    body.replaceChildren();
    const message = document.createElement('div');
    message.className = 'placeholder';
    message.textContent = error.message;
    body.append(message);
  }
}

function closeReader() {
  $('#reader').hidden = true;
  $('#readerBody').replaceChildren();
  $('#readerAttach').hidden = true;
  state.current = null;
  if ($('#qrModal').hidden) document.body.style.overflow = '';
  state.lastFocused?.focus?.();
}

async function deleteCurrentMessage() {
  const message = state.current;
  if (!message) return;

  try {
    await api(`/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' });
    state.messages = state.messages.filter((item) => item.id !== message.id);
    closeReader();
    renderMessages();
    toast('Message deleted', 'success', 'i-trash');
  } catch (error) {
    toast(error.message, 'error', 'i-alert');
  }
}

/* ------------------------------------------------------------------ */
/* inbox actions                                                       */
/* ------------------------------------------------------------------ */

async function newAddress() {
  const button = $('#newBtn');
  if (button.disabled) return;
  setFormHint('');
  try {
    await createInbox({}, { quiet: false });
  } catch {
    /* already surfaced */
  }
}

async function extendInbox() {
  try {
    const info = await api('/inbox/extend', { method: 'POST', body: {} });
    state.expiresAt = Number(info.expiresAt) || Date.now() + 60 * 60 * 1000;
    state.expiredNotified = false;
    startTimer();
    toast('Inbox extended by 60 minutes', 'success', 'i-clock');
  } catch (error) {
    toast(error.message, 'error', 'i-alert');
    if (error.status === 404) {
      createInbox({}, { quiet: true }).catch((createError) => showError(createError.message));
    }
  }
}

async function deleteInbox() {
  if (!state.address) return;
  const confirmed = window.confirm('Delete this inbox? Its address and messages will be released.');
  if (!confirmed) return;

  try {
    await api('/inbox', { method: 'DELETE' });
    state.address = '';
    state.messages = [];
    state.expiresAt = 0;
    closeReader();
    $('#addressText').textContent = 'loading…';
    $('#emptyAddress').textContent = 'your address';
    updateTitle();
    toast('Inbox deleted', 'success', 'i-trash');
    await createInbox({}, { quiet: true });
  } catch (error) {
    toast(error.message, 'error', 'i-alert');
  }
}

/* ------------------------------------------------------------------ */
/* qr                                                                  */
/* ------------------------------------------------------------------ */

function openQr() {
  if (!state.address) return;
  state.lastFocused = document.activeElement;

  $('#qrAddress').textContent = state.address;
  const image = $('#qrImg');
  const fallback = $('#qrFallback');
  fallback.hidden = true;
  image.hidden = false;
  image.onerror = () => {
    image.hidden = true;
    fallback.hidden = false;
  };
  image.src = `https://api.qrserver.com/v1/create-qr-code/?size=440x440&margin=12&data=${encodeURIComponent(
    state.address
  )}`;

  $('#qrModal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#qrCopyBtn').focus();
}

function closeQr() {
  $('#qrModal').hidden = true;
  if ($('#reader').hidden) document.body.style.overflow = '';
}

/* ------------------------------------------------------------------ */
/* events + boot                                                       */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#copyBtn').addEventListener('click', () => copyAddress());
  $('#qrBtn').addEventListener('click', openQr);
  $('#extendBtn').addEventListener('click', extendInbox);
  $('#newBtn').addEventListener('click', newAddress);
  $('#deleteBtn').addEventListener('click', deleteInbox);
  $('#refreshBtn').addEventListener('click', manualRefresh);
  $('#retryBtn').addEventListener('click', () => loadMessages({ silent: false }));
  $('#emptyAddress').addEventListener('click', () => copyAddress());
  $('#deleteMsg').addEventListener('click', deleteCurrentMessage);

  $$('[data-close]').forEach((element) => element.addEventListener('click', closeReader));
  $$('[data-qr-close]').forEach((element) => element.addEventListener('click', closeQr));
  $('#qrCopyBtn').addEventListener('click', () => copyAddress());

  $$('.seg-btn').forEach((button) => {
    button.addEventListener('click', () => {
      state.view = button.dataset.view === 'text' ? 'text' : 'html';
      syncSegmented();
      renderReaderBody();
    });
  });

  $('#imagesToggle').addEventListener('change', (event) => {
    state.showImages = event.target.checked;
    localStorage.setItem(IMAGES_KEY, state.showImages ? '1' : '0');
    if (state.current) renderReaderBody();
  });

  $('#customForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    const input = $('#customName');
    const local = input.value.trim().toLowerCase();
    const domain = $('#domainSelect').value;

    if (!local) {
      setFormHint('Pick a name for your address first.', true);
      input.focus();
      return;
    }
    if (local.length > 32 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(local)) {
      setFormHint('Use 1–32 letters, numbers, dots, dashes or underscores.', true);
      input.focus();
      return;
    }

    const [currentLocal, currentDomain] = state.address.split('@');
    if (local === currentLocal && domain === currentDomain) {
      setFormHint('That is already your address. Press Extend instead.', true);
      return;
    }

    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    setFormHint('Creating your address…');

    try {
      await createInbox({ local, domain }, { quiet: true });
      setFormHint('');
      input.value = '';
      toast('Custom address created', 'success', 'i-check');
    } catch (error) {
      setFormHint(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#qrModal').hidden) {
        closeQr();
        return;
      }
      if (!$('#reader').hidden) {
        closeReader();
        return;
      }
    }

    const tag = (event.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || event.target.isContentEditable;
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!$('#reader').hidden || !$('#qrModal').hidden) return;

    const key = event.key.toLowerCase();
    if (key === 'c') {
      event.preventDefault();
      copyAddress();
    } else if (key === 'n') {
      event.preventDefault();
      newAddress();
    } else if (key === 'r') {
      event.preventDefault();
      manualRefresh();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.address) loadMessages({ silent: true });
  });

  window.addEventListener('online', () => setOffline(false));
  window.addEventListener('offline', () => setOffline(true));
}

async function loadStats() {
  try {
    const stats = await api('/stats');
    if (!stats.enabled) return;
    const el = $('#footerStats');
    if (!el) return;
    const created = Number(stats.created) || 0;
    const active = Number(stats.active) || 0;
    el.textContent = `${created.toLocaleString()} inbox${created === 1 ? '' : 'es'} created · ${active.toLocaleString()} active right now`;
    el.hidden = false;
  } catch {
    /* stats are decorative */
  }
}

async function init() {
  initTheme();
  bindEvents();
  setOffline(false);

  try {
    const info = await api('/inbox');
    if (!info.address) {
      await createInbox({}, { quiet: true });
    } else {
      setInbox(info);
      await loadMessages({ silent: true });
    }
  } catch (error) {
    if (error.status === 404) {
      try {
        await createInbox({}, { quiet: true });
      } catch (createError) {
        showError(createError.message);
      }
    } else {
      showError(error.message);
    }
  }

  startPolling();
  loadStats();
}

init();
