// JOEL TIPS — probabilidade de gol no 1º tempo (HT), todas as ligas.
// Dados: placares públicos da ESPN (sem chave). Rode: node server.js  →  http://localhost:3100
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3100;
const CACHE_DIR = path.join(__dirname, 'cache');
const PUBLIC_DIR = path.join(__dirname, 'public');
const HISTORY_DAYS = 240;      // quanto histórico usar
const RECENT_GAMES = 20;       // últimos N jogos de cada time
const SHRINK = 4;              // "jogos fantasmas" com a média da liga (evita exagero com poucos jogos)
const MIN_GAMES = 5;           // mínimo de jogos de cada time para dar palpite
const ALL_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?limit=1000&dates=';

// nomes em português das principais; as outras usam o nome que vem da fonte
const PT = {
  'bra.1': 'Brasileirão Série A', 'bra.2': 'Brasileirão Série B', 'bra.3': 'Brasileirão Série C',
  'bra.copa_do_brazil': 'Copa do Brasil', 'conmebol.libertadores': 'Libertadores',
  'conmebol.sudamericana': 'Sul-Americana', 'uefa.champions': 'Champions League',
  'uefa.europa': 'Europa League', 'uefa.europa.conf': 'Conference League',
  'eng.1': 'Premier League', 'eng.2': 'Championship', 'eng.3': 'League One', 'eng.4': 'League Two',
  'esp.1': 'La Liga', 'esp.2': 'La Liga 2', 'ita.1': 'Serie A (Itália)', 'ita.2': 'Serie B (Itália)',
  'ger.1': 'Bundesliga', 'ger.2': '2. Bundesliga', 'fra.1': 'Ligue 1', 'fra.2': 'Ligue 2',
  'por.1': 'Liga Portugal', 'ned.1': 'Eredivisie', 'arg.1': 'Liga Argentina', 'usa.1': 'MLS',
  'mex.1': 'Liga MX', 'fifa.friendly': 'Amistosos de seleções', 'fifa.worldq.uefa': 'Eliminatórias Europa',
  'fifa.worldq.conmebol': 'Eliminatórias América do Sul', 'club.friendly': 'Amistosos de clubes',
};

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- util ----------
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) return await r.json();
    } catch (_) { /* tenta de novo */ }
    await sleep(700 * (i + 1));
  }
  return null;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

// ---------- leitura dos jogos ----------
function goalMinute(det) {
  const dv = det.clock && det.clock.displayValue;
  if (dv) { const m = parseInt(dv, 10); if (!isNaN(m)) return m; }
  return det.clock ? Math.ceil(det.clock.value / 60) : null;
}

const leagueNames = {}; // slug -> nome

function parseEvent(ev) {
  const c = ev.competitions && ev.competitions[0];
  if (!c) return null;
  const home = c.competitors.find((t) => t.homeAway === 'home');
  const away = c.competitors.find((t) => t.homeAway === 'away');
  if (!home || !away) return null;
  const link = (ev.links || []).map((l) => l.href).find((h) => /\/league\//.test(h || ''));
  const slug = link ? link.split('/league/')[1].split(/[/?#]/)[0] : (ev.uid.match(/l:(\d+)/) || [])[1] || '?';
  const note = c.altGameNote ? c.altGameNote.split(',')[0].trim() : null; // tira "Group C2", "Semifinals"...
  const name = PT[slug] || leagueNames[slug] || note || slug;
  if (!PT[slug] && note && !leagueNames[slug]) leagueNames[slug] = note;
  const st = ev.status || c.status || {};
  const goals = (c.details || []).filter((d) => d.scoringPlay && !d.shootout);
  let h1Home = 0, h1Away = 0;
  for (const g of goals) {
    const m = goalMinute(g);
    if (m == null || m > 45) continue;
    if (g.team && g.team.id === home.team.id) h1Home++; else h1Away++;
  }
  const scoreH = parseInt(home.score, 10) || 0, scoreA = parseInt(away.score, 10) || 0;
  return {
    id: ev.id, league: slug, leagueName: name, date: ev.date, state: st.type && st.type.state,
    statusName: st.type && st.type.name, clock: st.displayClock, period: st.period,
    home: { id: home.team.id, name: home.team.shortDisplayName || home.team.displayName, logo: home.team.logo },
    away: { id: away.team.id, name: away.team.shortDisplayName || away.team.displayName, logo: away.team.logo },
    scoreH, scoreA, h1Home, h1Away,
    // só confiamos no jogo se os gols listados batem com o placar
    reliable: goals.length === scoreH + scoreA,
  };
}

// ---------- cache por dia (todas as ligas numa consulta) ----------
const mem = new Map(); // day -> {at, events}

async function fetchDay(day, ttlMs) {
  const file = path.join(CACHE_DIR, `all_${day}.json`);
  const m = mem.get(day);
  if (m && (ttlMs === Infinity || Date.now() - m.at < ttlMs)) return m.events;
  if (ttlMs === Infinity && fs.existsSync(file)) {
    const events = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of events) if (!PT[e.league] && !leagueNames[e.league]) leagueNames[e.league] = e.leagueName.split(',')[0].trim();
    mem.set(day, { at: Date.now(), events });
    return events;
  }
  const d = await getJSON(ALL_URL + day);
  if (!d) return (m && m.events) || [];
  const events = (d.events || []).map(parseEvent).filter(Boolean);
  mem.set(day, { at: Date.now(), events });
  if (ttlMs === Infinity) fs.writeFileSync(file, JSON.stringify(events));
  return events;
}

// ---------- histórico + índices ----------
let history = [];                 // jogos encerrados e confiáveis, por data
let historyIds = new Set();
let byTeam = new Map();           // teamId -> jogos (por data)
let leagueIdx = new Map();        // league -> {dates, cumGoals, cumHit}
let globalIdx = null;
let loading = { done: 0, total: 0, ready: false };
let backtest = null;

async function loadHistory() {
  const today = new Date();
  const days = [];
  for (let n = HISTORY_DAYS; n >= 2; n--) days.push(ymd(addDays(today, -n)));
  loading.total = days.length;
  // historico.json = todos os dias já baixados num arquivo só (para hospedar sem baixar tudo de novo)
  const snap = path.join(__dirname, 'historico.json');
  if (fs.existsSync(snap)) {
    const byDay = JSON.parse(fs.readFileSync(snap, 'utf8'));
    for (const [day, events] of Object.entries(byDay)) {
      if (mem.has(day)) continue;
      for (const e of events) if (!PT[e.league] && !leagueNames[e.league]) leagueNames[e.league] = e.leagueName.split(',')[0].trim();
      mem.set(day, { at: Date.now(), events });
    }
  }
  const all = [];
  await pool(days, 6, async (day) => {
    for (const e of await fetchDay(day, Infinity)) all.push(e);
    loading.done++;
  });
  setHistory(all);
  loading.ready = true;
  console.log(`Histórico pronto: ${history.length} jogos de ${leagueIdx.size} competições.`);
}

function buildIdx(games) {
  const dates = [], cumGoals = [0], cumHit = [0];
  for (const g of games) {
    dates.push(g.date);
    const t = g.h1Home + g.h1Away;
    cumGoals.push(cumGoals[cumGoals.length - 1] + t);
    cumHit.push(cumHit[cumHit.length - 1] + (t > 0 ? 1 : 0));
  }
  return { dates, cumGoals, cumHit };
}

function setHistory(list) {
  const map = new Map(history.map((e) => [e.id, e]));
  for (const e of list) if (e.state === 'post' && e.reliable) map.set(e.id, e);
  history = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  historyIds = new Set(history.map((e) => e.id));
  byTeam = new Map(); const byLeague = new Map();
  for (const g of history) {
    for (const id of [g.home.id, g.away.id]) { if (!byTeam.has(id)) byTeam.set(id, []); byTeam.get(id).push(g); }
    if (!byLeague.has(g.league)) byLeague.set(g.league, []); byLeague.get(g.league).push(g);
  }
  leagueIdx = new Map([...byLeague].map(([k, v]) => [k, buildIdx(v)]));
  globalIdx = buildIdx(history);
  backtest = runBacktest();
}

// quantos itens de idx têm data < beforeDate (busca binária)
function countBefore(idx, beforeDate) {
  let lo = 0, hi = idx.dates.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (idx.dates[mid] < beforeDate) lo = mid + 1; else hi = mid; }
  return lo;
}

// ---------- modelo ----------
function teamStats(teamId, beforeDate) {
  const games = byTeam.get(teamId) || [];
  const out = [];
  for (let i = games.length - 1; i >= 0 && out.length < RECENT_GAMES; i--) {
    const g = games[i];
    if (g.date >= beforeDate) continue;
    if (g.home.id === teamId) out.push({ home: true, gf: g.h1Home, ga: g.h1Away });
    else out.push({ home: false, gf: g.h1Away, ga: g.h1Home });
  }
  return out;
}

function leagueAvg(league, beforeDate) {
  for (const idx of [leagueIdx.get(league), globalIdx]) {
    if (!idx) continue;
    const n = countBefore(idx, beforeDate);
    if (n >= 30) return { perTeam: idx.cumGoals[n] / n / 2, hit: idx.cumHit[n] / n };
  }
  return { perTeam: 0.55, hit: 0.7 };
}

function predict(match, beforeDate) {
  const sh = teamStats(match.home.id, beforeDate);
  const sa = teamStats(match.away.id, beforeDate);
  if (sh.length < MIN_GAMES || sa.length < MIN_GAMES) return null;
  const L = leagueAvg(match.league, beforeDate);
  const mu = Math.max(0.2, L.perTeam);
  const shr = (sum, n, prior) => (sum + SHRINK * prior) / (n + SHRINK);
  // dá peso extra aos jogos no mesmo mando (casa em casa, fora fora)
  const venueBlend = (arr, home, key) => {
    const allR = shr(arr.reduce((s, x) => s + x[key], 0), arr.length, mu);
    const v = arr.filter((x) => x.home === home);
    if (v.length < 4) return allR;
    return 0.5 * allR + 0.5 * shr(v.reduce((s, x) => s + x[key], 0), v.length, mu);
  };
  const attH = venueBlend(sh, true, 'gf'), defH = venueBlend(sh, true, 'ga');
  const attA = venueBlend(sa, false, 'gf'), defA = venueBlend(sa, false, 'ga');
  const lam = (attH * defA) / mu + (attA * defH) / mu;
  const pPois = 1 - Math.exp(-lam);
  const rate = (arr) => shr(arr.filter((x) => x.gf + x.ga > 0).length, arr.length, L.hit);
  const pEmp = (rate(sh) + rate(sa)) / 2;
  return {
    raw: 0.6 * pPois + 0.4 * pEmp, lam, p15: 1 - Math.exp(-lam) * (1 + lam),
    rateHome: rate(sh), rateAway: rate(sa), nHome: sh.length, nAway: sa.length,
  };
}

// Teste no passado: cada palpite usa só jogos anteriores; confere se saiu gol no 1º tempo.
function runBacktest() {
  const rows = [];
  for (const g of history) {
    const p = predict(g, g.date);
    if (p) rows.push({ p: p.raw, hit: g.h1Home + g.h1Away > 0 });
  }
  // calibração por faixa de 5%: probabilidade mostrada = o que realmente aconteceu nessa faixa
  const bins = {};
  for (const r of rows) {
    const b = Math.min(19, Math.floor(r.p * 20));
    (bins[b] ||= { n: 0, hit: 0 });
    bins[b].n++; bins[b].hit += r.hit;
  }
  const thresholds = [0.7, 0.75, 0.8, 0.85, 0.9].map((t) => {
    const sel = rows.filter((r) => calibrate(r.p, bins) >= t);
    return { t, n: sel.length, acc: sel.length ? sel.filter((r) => r.hit).length / sel.length : null };
  });
  const base = rows.length ? rows.filter((r) => r.hit).length / rows.length : null;
  return { n: rows.length, base, bins, thresholds };
}

function calibrate(raw, bins) {
  const b = bins && bins[Math.min(19, Math.floor(raw * 20))];
  if (!b || b.n < 15) return raw;
  const k = 30; // mistura o observado com o bruto quando a faixa tem poucos jogos
  return (b.hit + k * raw) / (b.n + k);
}

// Ao vivo: chance de sair gol no tempo que falta do 1º tempo
function liveProb(match, lamFull) {
  const goals1 = match.h1Home + match.h1Away;
  if (match.state === 'post' || (match.state === 'in' && match.period >= 2) || match.statusName === 'STATUS_HALFTIME') {
    return { status: goals1 > 0 ? 'green' : 'red', p05: goals1 > 0 ? 1 : 0, p15: goals1 > 1 ? 1 : 0 };
  }
  if (match.state !== 'in') return null;
  const minute = Math.min(45, parseInt(match.clock, 10) || 0);
  const remaining = Math.max(0, 45 - minute) + 2; // + acréscimos
  const lam = lamFull * (remaining / 45);
  const p0 = Math.exp(-lam), p1 = lam * p0;
  const p05 = goals1 >= 1 ? 1 : 1 - p0;
  const p15 = goals1 >= 2 ? 1 : goals1 === 1 ? 1 - p0 : 1 - p0 - p1;
  return { status: goals1 > 0 ? 'green' : 'live', minute, p05, p15 };
}

// ---------- jogos de hoje / próximos ----------
async function currentMatches() {
  const today = new Date();
  const out = [];
  await pool([-1, 0, 1, 2, 3], 5, async (n) => {
    const evs = await fetchDay(ymd(addDays(today, n)), n <= 0 ? 25000 : 10 * 60000);
    for (const e of evs) out.push(e);
  });
  // jogos que terminaram entram no histórico
  const finished = out.filter((e) => e.state === 'post' && e.reliable && !historyIds.has(e.id));
  if (finished.length && loading.ready) setHistory(finished);

  const now = Date.now();
  const bins = backtest && backtest.bins;
  const seen = new Set();
  const list = [];
  for (const m of out) {
    if (seen.has(m.id)) continue; seen.add(m.id);
    const t = new Date(m.date).getTime();
    const relevant = m.state === 'in' || (m.state === 'pre' && t < now + 3 * 86400000) ||
      (m.state === 'post' && now - t < 6 * 3600000);
    if (!relevant) continue;
    const p = predict(m, m.date);
    if (!p) continue;
    const prob = calibrate(p.raw, bins);
    list.push({
      ...m, prob, p15: p.p15, lam: p.lam, rateHome: p.rateHome, rateAway: p.rateAway,
      nHome: p.nHome, nAway: p.nAway, live: liveProb(m, -Math.log(1 - Math.min(prob, 0.995))),
    });
  }
  list.sort((a, b) => (a.state === 'in' ? 0 : 1) - (b.state === 'in' ? 0 : 1) || b.prob - a.prob);
  return list;
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
let cached = { at: 0, data: null };

function startServer() {
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/status') {
      return send(res, 200, { loading, backtest: backtest && { n: backtest.n, base: backtest.base, thresholds: backtest.thresholds, ligas: leagueIdx.size } });
    }
    if (url.pathname === '/api/jogos') {
      if (!loading.ready) return send(res, 200, { loading, jogos: [] });
      if (Date.now() - cached.at > 15000) cached = { at: Date.now(), data: await currentMatches() };
      return send(res, 200, { loading, jogos: cached.data, atualizado: new Date(cached.at).toISOString() });
    }
    const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { erro: e.message });
  }
}).listen(PORT, () => {
  console.log(`JOEL TIPS — abra no navegador: http://localhost:${PORT}`);
  console.log('Carregando histórico (a 1ª vez demora alguns minutos; depois fica salvo em /cache)...');
  loadHistory();
});
}

if (require.main === module) startServer();
module.exports = { loadHistory, predict, getState: () => ({ history, leagueIdx }), leagueAvg, teamStats };

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
