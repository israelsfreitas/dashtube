/* ═══════════════════════════════════════════
   YT MONITOR — app.js
   ═══════════════════════════════════════════ */

'use strict';

// ── CONSTANTS ──────────────────────────────
const LS_KEY_THEME    = 'ytm_theme';
const LS_KEY_APIKEY   = 'ytm_apikey';
const LS_KEY_CHANNELS = 'ytm_channels';
const PAGE_SIZE       = 8;
const REFRESH_MS      = 10 * 60 * 1000; // 10 minutes
const WEEK_LABELS     = ['D','S','T','Q','Q','S','S'];
const YT_BASE         = 'https://www.googleapis.com/youtube/v3';

// ── STATE ───────────────────────────────────
let state = {
  theme:    'dark',
  apiKey:   '',
  channels: [],   // { id, startDate, options:{showVideos,showLastVideo,showWeekly}, data:{} }
};
let copChannelId = null; // which channel is open in options panel
let sortableInst = null;
let refreshTimer = null;
let intersectionObs = null;

// ── UTILS ───────────────────────────────────
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  n = Number(n);
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K';
  return n.toLocaleString('pt-BR');
}

function lifetime(startDateStr) {
  if (!startDateStr) return '—';
  const start = new Date(startDateStr);
  const now   = new Date();
  const diff  = now - start;
  if (diff < 0) return '—';
  const days  = Math.floor(diff / 86400000);
  const yrs   = Math.floor(days / 365);
  const mos   = Math.floor((days % 365) / 30);
  const d     = days % 30;
  let s = '';
  if (yrs) s += `${yrs}a `;
  if (mos) s += `${mos}m `;
  s += `${d}d`;
  return s.trim();
}

function getWeekUploadDays(publishedDates) {
  // returns set of weekday indices (0=Sun) that have an upload in the current week
  const now   = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay()); // Sunday
  start.setHours(0,0,0,0);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);

  const days = new Set();
  for (const d of publishedDates) {
    const dt = new Date(d);
    if (dt >= start && dt < end) days.add(dt.getDay());
  }
  return days;
}

function showToast(msg) {
  const t = $('#loading-toast');
  const m = $('#loading-msg');
  m.textContent = msg;
  t.classList.remove('hidden');
}
function hideToast() { $('#loading-toast').classList.add('hidden'); }

function setStatus(el, msg, type = '') {
  el.textContent = msg;
  el.className = 'field-hint' + (type ? ` ${type}` : '');
}

// ── PERSISTENCE ─────────────────────────────
function saveState() {
  localStorage.setItem(LS_KEY_THEME,    state.theme);
  localStorage.setItem(LS_KEY_APIKEY,   state.apiKey);
  localStorage.setItem(LS_KEY_CHANNELS, JSON.stringify(state.channels));
}

function loadState() {
  state.theme   = localStorage.getItem(LS_KEY_THEME)   || 'dark';
  state.apiKey  = localStorage.getItem(LS_KEY_APIKEY)  || '';
  try {
    const raw = localStorage.getItem(LS_KEY_CHANNELS);
    state.channels = raw ? JSON.parse(raw) : [];
  } catch { state.channels = []; }

  // ensure each channel has required shape
  state.channels = state.channels.map(ch => ({
    id:        ch.id,
    startDate: ch.startDate || '',
    options: {
      showVideos:    ch.options?.showVideos    ?? false,
      showLastVideo: ch.options?.showLastVideo ?? false,
      showWeekly:    ch.options?.showWeekly    ?? false,
    },
    data: ch.data || {},
  }));
}

// ── THEME ────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const tog   = $('#theme-toggle');
  const label = $('#theme-label');
  tog.checked       = theme === 'light';
  label.textContent = theme === 'light' ? 'Claro' : 'Escuro';
}

// ── YOUTUBE API ──────────────────────────────
async function ytFetch(endpoint, params) {
  const url = new URL(`${YT_BASE}/${endpoint}`);
  url.searchParams.set('key', state.apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function fetchChannelData(channel) {
  const { id, options, startDate } = channel;

  // 1. Basic channel info
  const chResp = await ytFetch('channels', {
    part: 'snippet,statistics',
    id,
  });
  if (!chResp.items?.length) throw new Error('Canal não encontrado');
  const item  = chResp.items[0];
  const snip  = item.snippet;
  const stats = item.statistics;

  const data = {
    name:      snip.title,
    avatar:    snip.thumbnails?.medium?.url || snip.thumbnails?.default?.url || '',
    subs:      Number(stats.subscriberCount)  || 0,
    views:     Number(stats.viewCount)        || 0,
    videos:    Number(stats.videoCount)       || 0,
    uploadPlaylistId: snip.title ? id.replace(/^UC/, 'UU') : null,
    lastVideo: null,
    weekDays:  new Set(),
    fetchedAt: Date.now(),
  };

  // 2. Optional: last video + weekly (via uploads playlist)
  if (options.showLastVideo || options.showWeekly) {
    const plId = id.replace(/^UC/, 'UU');
    try {
      const plResp = await ytFetch('playlistItems', {
        part:       'snippet,contentDetails',
        playlistId: plId,
        maxResults: options.showWeekly ? 50 : 1,
      });
      const plItems = plResp.items || [];

      if (plItems.length > 0 && options.showLastVideo) {
        const last   = plItems[0];
        const vidId  = last.contentDetails?.videoId;
        const thumb  = last.snippet?.thumbnails?.medium?.url
                    || last.snippet?.thumbnails?.default?.url
                    || '';
        const title  = last.snippet?.title || '';

        // fetch video stats for views
        let recentViews = 0;
        if (vidId) {
          try {
            const vResp = await ytFetch('videos', {
              part: 'statistics',
              id:   vidId,
            });
            recentViews = Number(vResp.items?.[0]?.statistics?.viewCount || 0);
          } catch {/* non-critical */}
        }
        data.lastVideo = { thumb, title, views: recentViews };
      }

      if (options.showWeekly) {
        const pubDates = plItems.map(i => i.contentDetails?.videoPublishedAt || i.snippet?.publishedAt).filter(Boolean);
        data.weekDays  = getWeekUploadDays(pubDates);
      }
    } catch {/* playlist fetch failed silently */}
  }

  return data;
}

async function refreshAllChannels() {
  if (!state.apiKey || !state.channels.length) return;
  showToast('Atualizando canais…');
  let errors = 0;
  for (const ch of state.channels) {
    try {
      ch.data = await fetchChannelData(ch);
    } catch (e) {
      ch.data.error = e.message;
      errors++;
    }
  }
  saveState();
  renderStage();
  if (errors) {
    showToast(`${errors} erro(s) ao buscar dados`);
    setTimeout(hideToast, 3000);
  } else {
    hideToast();
  }
}

async function refreshSingleChannel(id) {
  const ch = state.channels.find(c => c.id === id);
  if (!ch || !state.apiKey) return;
  showToast(`Buscando ${ch.data?.name || id}…`);
  try {
    ch.data = await fetchChannelData(ch);
    saveState();
    renderStage();
    hideToast();
  } catch (e) {
    ch.data.error = e.message;
    saveState();
    renderStage();
    showToast(`Erro: ${e.message}`);
    setTimeout(hideToast, 3000);
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAllChannels, REFRESH_MS);
}

// ── RENDER STAGE ─────────────────────────────
function renderStage() {
  const stage    = $('#stage');
  const dotsNav  = $('#dots-nav');
  const empty    = $('#empty-state');
  const channels = state.channels;

  // Remove old pages (not the empty-state div)
  $$('.page', stage).forEach(p => p.remove());

  if (!channels.length) {
    empty.style.display = 'flex';
    dotsNav.innerHTML = '';
    rebindIntersection([]);
    return;
  }
  empty.style.display = 'none';

  // Chunk into pages of PAGE_SIZE
  const pages = [];
  for (let i = 0; i < channels.length; i += PAGE_SIZE) {
    pages.push(channels.slice(i, i + PAGE_SIZE));
  }

  pages.forEach((pageChannels, pageIdx) => {
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.pageIndex = pageIdx;

    const grid = document.createElement('div');
    grid.className = 'channel-grid';

    pageChannels.forEach(ch => {
      grid.appendChild(buildBox(ch));
    });

    page.appendChild(grid);
    stage.appendChild(page);
  });

  // Dots
  dotsNav.innerHTML = '';
  pages.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.className = 'dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('aria-label', `Página ${i + 1}`);
    dot.addEventListener('click', () => scrollToPage(i));
    dotsNav.appendChild(dot);
  });

  rebindIntersection($$('.page', stage));
}

function buildBox(ch) {
  const { id, startDate, options, data } = ch;
  const box = document.createElement('div');
  box.className = 'channel-box';
  box.dataset.channelId = id;

  if (data.error) {
    const badge = document.createElement('div');
    badge.className = 'box-error-badge';
    badge.title = data.error;
    box.appendChild(badge);
  }

  // ── Header: avatar + name + lifetime ──
  const header = document.createElement('div');
  header.className = 'box-header';

  if (data.avatar) {
    const img = document.createElement('img');
    img.className  = 'box-avatar';
    img.src        = data.avatar;
    img.alt        = data.name || id;
    img.loading    = 'lazy';
    header.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className   = 'box-avatar-placeholder';
    ph.textContent = (data.name || id).charAt(0).toUpperCase();
    header.appendChild(ph);
  }

  const nameWrap = document.createElement('div');
  nameWrap.style.overflow = 'hidden';
  nameWrap.style.flex = '1';

  const nameEl = document.createElement('div');
  nameEl.className   = 'box-name';
  nameEl.textContent = data.name || id;
  nameWrap.appendChild(nameEl);

  if (startDate) {
    const ltEl = document.createElement('div');
    ltEl.className   = 'box-lifetime';
    ltEl.textContent = lifetime(startDate);
    nameWrap.appendChild(ltEl);
  }

  header.appendChild(nameWrap);
  box.appendChild(header);

  // ── Subs (colossal) ──
  const subsWrap = document.createElement('div');
  subsWrap.className = 'box-subs';

  const subsVal = document.createElement('div');
  subsVal.className   = 'subs-value';
  subsVal.textContent = data.subs !== undefined ? fmt(data.subs) : '—';
  subsWrap.appendChild(subsVal);

  const subsLbl = document.createElement('div');
  subsLbl.className   = 'subs-label';
  subsLbl.textContent = 'inscritos';
  subsWrap.appendChild(subsLbl);
  box.appendChild(subsWrap);

  // ── Views ──
  const viewsEl = document.createElement('div');
  viewsEl.className = 'box-views';
  viewsEl.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
    ${data.views !== undefined ? fmt(data.views) + ' visualizações' : '—'}
  `;
  box.appendChild(viewsEl);

  // ── Optional: total videos ──
  if (options.showVideos) {
    const vidEl = document.createElement('div');
    vidEl.className = 'box-videos';
    vidEl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="23 7 16 12 23 17 23 7"/>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
      </svg>
      ${data.videos !== undefined ? fmt(data.videos) + ' vídeos' : '—'}
    `;
    box.appendChild(vidEl);
  }

  // ── Optional: last video thumb ──
  if (options.showLastVideo && data.lastVideo) {
    const lv = data.lastVideo;
    const wrap = document.createElement('div');
    wrap.className = 'box-last-video';

    if (lv.thumb) {
      const img = document.createElement('img');
      img.className = 'last-thumb';
      img.src       = lv.thumb;
      img.alt       = lv.title;
      img.loading   = 'lazy';
      wrap.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'last-thumb-placeholder';
      wrap.appendChild(ph);
    }

    const info = document.createElement('div');
    info.className = 'last-video-info';

    const titleEl = document.createElement('div');
    titleEl.className   = 'last-video-title';
    titleEl.textContent = lv.title || '—';
    titleEl.title       = lv.title || '';
    info.appendChild(titleEl);

    const vEl = document.createElement('div');
    vEl.className   = 'last-video-views';
    vEl.textContent = fmt(lv.views) + ' views';
    info.appendChild(vEl);

    wrap.appendChild(info);
    box.appendChild(wrap);
  }

  // ── Optional: weekly indicator ──
  if (options.showWeekly) {
    const todayDay = new Date().getDay();
    const wrap = document.createElement('div');
    wrap.className = 'box-weekly';

    WEEK_LABELS.forEach((lbl, i) => {
      const dayWrap = document.createElement('div');
      dayWrap.className = 'week-day';

      const dot = document.createElement('div');
      dot.className = 'week-dot'
        + (data.weekDays?.has?.(i) ? ' active' : '')
        + (i === todayDay ? ' today' : '');
      dayWrap.appendChild(dot);

      const label = document.createElement('div');
      label.className   = 'week-label';
      label.textContent = lbl;
      dayWrap.appendChild(label);

      wrap.appendChild(dayWrap);
    });

    box.appendChild(wrap);
  }

  return box;
}

// ── INTERSECTION OBSERVER (dots) ──────────────
function rebindIntersection(pages) {
  if (intersectionObs) intersectionObs.disconnect();
  if (!pages.length) return;

  const dotsNav = $('#dots-nav');
  intersectionObs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const idx  = Number(entry.target.dataset.pageIndex);
        const dots = $$('.dot', dotsNav);
        dots.forEach((d, i) => d.classList.toggle('active', i === idx));
      }
    });
  }, { root: $('#stage'), threshold: 0.6 });

  pages.forEach(p => intersectionObs.observe(p));
}

function scrollToPage(idx) {
  const pages = $$('.page', $('#stage'));
  if (pages[idx]) pages[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
}

// ── MODAL ─────────────────────────────────────
function openModal() {
  const overlay = $('#modal-overlay');
  overlay.classList.remove('hidden', 'fade-out');
  overlay.classList.add('fade-in');
  renderChannelList();
  // populate API key field
  const inp = $('#api-key-input');
  if (state.apiKey) inp.value = state.apiKey;
}

function closeModal() {
  const overlay = $('#modal-overlay');
  overlay.classList.remove('fade-in');
  overlay.classList.add('fade-out');
  setTimeout(() => overlay.classList.add('hidden'), 190);
  closeChannelOptions();
}

function openChannelOptions(channelId) {
  const ch    = state.channels.find(c => c.id === channelId);
  if (!ch) return;
  copChannelId = channelId;

  const panel = $('#channel-options-panel');
  $('#cop-title').textContent = ch.data?.name || ch.id;

  // Set toggles
  $$('[data-option]', panel).forEach(inp => {
    const opt = inp.dataset.option;
    inp.checked = ch.options[opt] ?? false;
  });

  panel.classList.remove('hidden');
}

function closeChannelOptions() {
  $('#channel-options-panel').classList.add('hidden');
  copChannelId = null;
}

// ── CHANNEL LIST (modal) ──────────────────────
function renderChannelList() {
  const ul       = $('#channel-list');
  const noMsg    = $('#no-channels-msg');
  const countBdg = $('#channel-count');
  ul.innerHTML   = '';

  const channels = state.channels;
  countBdg.textContent = channels.length;
  noMsg.style.display  = channels.length ? 'none' : 'block';

  channels.forEach(ch => {
    const li = document.createElement('li');
    li.className = 'channel-item';
    li.dataset.channelId = ch.id;

    // drag handle
    li.innerHTML = `
      <span class="ci-drag">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="8" y1="6"  x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
          <line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6"  x2="3.01" y2="6"/>
          <line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
      </span>
    `;

    if (ch.data?.avatar) {
      const img = document.createElement('img');
      img.className = 'ci-avatar';
      img.src       = ch.data.avatar;
      img.alt       = ch.data.name || ch.id;
      li.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className   = 'ci-avatar-placeholder';
      ph.textContent = (ch.data?.name || ch.id).charAt(0).toUpperCase();
      li.appendChild(ph);
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'ci-name';
    nameEl.textContent = ch.data?.name || ch.id;
    li.appendChild(nameEl);

    const actions = document.createElement('div');
    actions.className = 'ci-actions';

    // Settings button
    const settBtn = document.createElement('button');
    settBtn.className = 'ci-btn';
    settBtn.title     = 'Opções';
    settBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>`;
    settBtn.addEventListener('click', () => openChannelOptions(ch.id));
    actions.appendChild(settBtn);

    // Refresh button
    const refBtn = document.createElement('button');
    refBtn.className = 'ci-btn';
    refBtn.title     = 'Atualizar';
    refBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>`;
    refBtn.addEventListener('click', () => refreshSingleChannel(ch.id));
    actions.appendChild(refBtn);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'ci-btn danger';
    delBtn.title     = 'Remover';
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
      <path d="M10 11v6"/><path d="M14 11v6"/>
      <path d="M9 6V4h6v2"/>
    </svg>`;
    delBtn.addEventListener('click', () => removeChannel(ch.id));
    actions.appendChild(delBtn);

    li.appendChild(actions);
    ul.appendChild(li);
  });

  // Init / update SortableJS
  if (sortableInst) sortableInst.destroy();
  sortableInst = Sortable.create(ul, {
    animation:     150,
    ghostClass:    'sortable-ghost',
    handle:        '.ci-drag',
    onEnd(evt) {
      const { oldIndex, newIndex } = evt;
      if (oldIndex === newIndex) return;
      const moved = state.channels.splice(oldIndex, 1)[0];
      state.channels.splice(newIndex, 0, moved);
      saveState();
      renderStage();
    },
  });
}

function removeChannel(id) {
  state.channels = state.channels.filter(ch => ch.id !== id);
  saveState();
  renderChannelList();
  renderStage();
}

// ── ADD CHANNEL ───────────────────────────────
async function addChannel() {
  const idInp   = $('#channel-id-input');
  const dateInp = $('#channel-date-input');
  const status  = $('#add-channel-status');
  const btn     = $('#add-channel-btn');

  const rawId = idInp.value.trim();
  if (!rawId.startsWith('UC') || rawId.length < 10) {
    setStatus(status, 'ID inválido. Deve começar com UC…', 'error');
    return;
  }
  if (!state.apiKey) {
    setStatus(status, 'Insira a API Key antes.', 'error');
    return;
  }
  if (state.channels.find(c => c.id === rawId)) {
    setStatus(status, 'Canal já adicionado.', 'error');
    return;
  }

  btn.disabled = true;
  setStatus(status, 'Buscando canal…', '');
  showToast('Adicionando canal…');

  const newCh = {
    id:        rawId,
    startDate: dateInp.value || '',
    options:   { showVideos: false, showLastVideo: false, showWeekly: false },
    data:      {},
  };

  try {
    newCh.data = await fetchChannelData(newCh);
    state.channels.push(newCh);
    saveState();
    setStatus(status, `✓ "${newCh.data.name}" adicionado!`, 'success');
    idInp.value   = '';
    dateInp.value = '';
    renderChannelList();
    renderStage();
    hideToast();
  } catch (e) {
    setStatus(status, `Erro: ${e.message}`, 'error');
    hideToast();
  } finally {
    btn.disabled = false;
  }
}

// ── BOOT ─────────────────────────────────────
function init() {
  loadState();
  applyTheme(state.theme);

  // Render immediately with cached data
  renderStage();

  // Then fetch fresh data if API key exists
  if (state.apiKey && state.channels.length) {
    refreshAllChannels();
  }

  scheduleRefresh();

  // ── Event listeners ──

  // Gear button
  $('#gear-btn').addEventListener('click', openModal);

  // Modal close
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-overlay').addEventListener('click', e => {
    if (e.target === $('#modal-overlay')) closeModal();
  });

  // Theme toggle
  $('#theme-toggle').addEventListener('change', e => {
    state.theme = e.target.checked ? 'light' : 'dark';
    applyTheme(state.theme);
    saveState();
  });

  // Save API key
  $('#save-api-key').addEventListener('click', () => {
    const val = $('#api-key-input').value.trim();
    const st  = $('#api-key-status');
    if (!val) { setStatus(st, 'Campo vazio.', 'error'); return; }
    state.apiKey = val;
    saveState();
    setStatus(st, '✓ Salvo.', 'success');
    if (state.channels.length) refreshAllChannels();
  });

  // Add channel
  $('#add-channel-btn').addEventListener('click', addChannel);
  $('#channel-id-input').addEventListener('keydown', e => { if (e.key === 'Enter') addChannel(); });

  // Channel options panel: back
  $('#cop-back').addEventListener('click', () => {
    // save options before closing
    if (copChannelId) {
      const ch = state.channels.find(c => c.id === copChannelId);
      if (ch) {
        $$('[data-option]', $('#channel-options-panel')).forEach(inp => {
          ch.options[inp.dataset.option] = inp.checked;
        });
        saveState();
        renderStage();
      }
    }
    closeChannelOptions();
  });

  // Channel option toggles — live save
  $$('[data-option]', $('#channel-options-panel')).forEach(inp => {
    inp.addEventListener('change', () => {
      if (!copChannelId) return;
      const ch = state.channels.find(c => c.id === copChannelId);
      if (!ch) return;
      ch.options[inp.dataset.option] = inp.checked;
      // If enabling an optional that needs data, re-fetch
      const needsFetch = inp.checked && (inp.dataset.option === 'showLastVideo' || inp.dataset.option === 'showWeekly');
      if (needsFetch && state.apiKey) refreshSingleChannel(copChannelId);
      else { saveState(); renderStage(); }
    });
  });

  // Keyboard: Escape to close modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const panel = $('#channel-options-panel');
      if (!panel.classList.contains('hidden')) {
        closeChannelOptions();
      } else {
        closeModal();
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
