// JOEL TIPS — probabilidades de: gol no 1º tempo (+0.5 HT), +2.5 cartões, +8.5 escanteios e ambas marcam (partida toda).
// Todas as ligas. Dados: placares públicos da ESPN (sem chave). Rode: node server.js  →  http://localhost:3100
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3100;
const CACHE_DIR = path.join(__dirname, 'cache');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SNAPSHOT = path.join(__dirname, 'historico.json');
const DATA_VERSION = 4;      // muda quando o formato salvo muda (força baixar de novo)
const HISTORY_DAYS = 240;      // quanto histórico usar
const RECENT_GAMES = 20;       // últimos N jogos de cada time
const SHRINK = 4;              // "jogos fantasmas" com a média da liga (evita exagero com poucos jogos)
const MIN_GAMES = +(process.env.MIN_GAMES || 3); // testado: 3 mantém o acerto e cobre mais jogos que 5         // mínimo de jogos de cada time para dar palpite
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

// ---------- mercados ----------
// get(g) -> [valor do mandante, valor do visitante]; known(g) -> o jogo tem esse dado?
const MARKETS = {
  ht: {
    label: 'Gol no 1º tempo', line: 0.5, full: false,
    get: (g) => [g.h1Home, g.h1Away], known: (g) => g.reliable,
  },
  cards: {
    label: '+2.5 cartões', line: 2.5, full: true,
    get: (g) => [g.cardsH, g.cardsA], known: (g) => g.cardsH != null && cardLeagues.has(g.league),
  },
  corners: {
    label: '+8.5 escanteios', line: 8.5, full: true,
    get: (g) => [g.cornersH, g.cornersA],
    // 0 x 0 escanteios no fim do jogo = a fonte não registrou (jogo real sem escanteio é raríssimo);
    // com prorrogação o total inclui a prorrogação, que a aposta não conta → fica de fora
    known: (g) => g.cornersH != null && g.cornersA != null && g.cornersH + g.cornersA > 0 && !g.extraTime,
  },
  btts: {
    label: 'Ambas marcam', line: 0.5, full: true,
    // gols da partida inteira (90 min); jogo com prorrogação fica de fora, o placar já inclui a prorrogação
    get: (g) => [g.scoreH, g.scoreA], known: (g) => !g.extraTime,
    hit: (a, b) => a > 0 && b > 0,
    // P(mandante marca) × P(visitante marca)
    model: (lamH, lamA) => (1 - Math.exp(-lamH)) * (1 - Math.exp(-lamA)),
    next: (lamH, lamA) => pOver(lamH + lamA, 2.5), // mostra também a chance de +2.5 gols
    // mercado difícil: média de ~52% e teto real ~60–65% (testado fora da amostra) → faixas mais baixas
    ths: [0.55, 0.6, 0.65, 0.7],
  },
};
// padrão dos mercados de "total acima da linha"
for (const M of Object.values(MARKETS)) {
  M.hit ||= (a, b) => a + b > M.line;
  M.model ||= (lamH, lamA) => pOver(lamH + lamA, M.line);
  M.next ||= (lamH, lamA) => pOver(lamH + lamA, M.line + 1);
}
const MKEYS = Object.keys(MARKETS);
let cardLeagues = new Set(); // ligas em que a fonte registra cartões de verdade

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

// P(X > line) para X ~ Poisson(lam)
function pOver(lam, line) {
  let p = Math.exp(-lam), cdf = p;
  for (let k = 1; k <= Math.floor(line); k++) { p *= lam / k; cdf += p; }
  return Math.max(0, 1 - cdf);
}

// ---------- leitura dos jogos ----------
function detMinute(det) {
  const dv = det.clock && det.clock.displayValue;
  if (dv) { const m = parseInt(dv, 10); if (!isNaN(m)) return m; }
  return det.clock ? Math.ceil(det.clock.value / 60) : null;
}

const leagueNames = {}; // id -> nome vindo da fonte
const slugById = {};    // id -> código tipo "bra.1"
const leagueName = (id) => PT[slugById[id]] || leagueNames[id] || slugById[id] || 'Futebol';

function parseEvent(ev) {
  const c = ev.competitions && ev.competitions[0];
  if (!c) return null;
  const home = c.competitors.find((t) => t.homeAway === 'home');
  const away = c.competitors.find((t) => t.homeAway === 'away');
  if (!home || !away) return null;
  // a liga é identificada pelo número (vem em todo jogo); o código tipo "bra.1" só vem em jogos encerrados
  const leagueId = 'l' + ((ev.uid.match(/l:(\d+)/) || [])[1] || '0');
  const link = (ev.links || []).map((l) => l.href).find((h) => /\/league\//.test(h || ''));
  if (link) slugById[leagueId] = link.split('/league/')[1].split(/[/?#]/)[0];
  const note = c.altGameNote ? c.altGameNote.split(',')[0].trim() : null; // tira "Group C2", "Semifinals"...
  if (note && !leagueNames[leagueId]) leagueNames[leagueId] = note;
  const slug = leagueId;
  const name = leagueName(leagueId);
  const st = ev.status || c.status || {};
  const det = c.details || [];
  const goals = det.filter((d) => d.scoringPlay && !d.shootout);
  let h1Home = 0, h1Away = 0;
  for (const g of goals) {
    const m = detMinute(g);
    if (m == null || m > 45) continue;
    if (g.team && g.team.id === home.team.id) h1Home++; else h1Away++;
  }
  // cartões: amarelos + vermelhos (cada evento conta 1), só nos 90 min + acréscimos (sem prorrogação)
  let cardsH = null, cardsA = null;
  if (det.length) {
    cardsH = 0; cardsA = 0;
    for (const d of det) {
      if (!(d.yellowCard || d.redCard) || d.shootout) continue;
      const min = detMinute(d);
      if (min != null && min > 90) continue;
      if (d.team && d.team.id === home.team.id) cardsH++; else cardsA++;
    }
  }
  const stat = (t, name) => {
    const s = (t.statistics || []).find((x) => x.name === name);
    const v = s ? parseFloat(s.displayValue) : NaN;
    return isNaN(v) ? null : v;
  };
  const scoreH = parseInt(home.score, 10) || 0, scoreA = parseInt(away.score, 10) || 0;
  const statusName = (st.type && st.type.name) || '';
  return {
    // done = terminou de verdade (adiado/cancelado/abandonado também vêm como "post", mas sem resultado)
    done: !!(st.type && st.type.completed) && /FULL_TIME|FINAL/.test(statusName),
    extraTime: /AET|PEN|AGT/.test(statusName),
    id: ev.id, league: slug, slug: slugById[leagueId] || null, leagueName: name, date: ev.date, state: st.type && st.type.state,
    statusName: st.type && st.type.name, clock: st.displayClock, period: st.period,
    home: { id: home.team.id, name: home.team.shortDisplayName || home.team.displayName, logo: home.team.logo },
    away: { id: away.team.id, name: away.team.shortDisplayName || away.team.displayName, logo: away.team.logo },
    scoreH, scoreA, h1Home, h1Away, cardsH, cardsA,
    cornersH: stat(home, 'wonCorners'), cornersA: stat(away, 'wonCorners'),
    // só confiamos nos gols se os listados batem com o placar
    reliable: goals.length === scoreH + scoreA,
  };
}

function learnLeague(e) {
  if (e.slug && !slugById[e.league]) slugById[e.league] = e.slug;
  if (!leagueNames[e.league] && e.leagueName) leagueNames[e.league] = e.leagueName;
}

// ---------- cache por dia (todas as ligas numa consulta) ----------
const mem = new Map(); // day -> {at, events}

async function fetchDay(day, ttlMs) {
  const file = path.join(CACHE_DIR, `v${DATA_VERSION}_${day}.json`);
  const m = mem.get(day);
  if (m && (ttlMs === Infinity || Date.now() - m.at < ttlMs)) return m.events;
  if (ttlMs === Infinity && fs.existsSync(file)) {
    const events = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of events) learnLeague(e);
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
let history = [];                 // jogos encerrados, por data
let historyIds = new Set();
let byTeam = new Map();           // teamId -> jogos (por data)
let leagueIdx = {};               // mercado -> Map(liga -> índice)
let globalIdx = {};               // mercado -> índice
let loading = { done: 0, total: 0, ready: false };
let backtest = {};                // mercado -> resultado
let leagueCount = 0;

async function loadHistory() {
  const today = new Date();
  const days = [];
  for (let n = HISTORY_DAYS; n >= 2; n--) days.push(ymd(addDays(today, -n)));
  loading.total = days.length;
  // historico.json = dias já baixados num arquivo só (para hospedar sem baixar tudo de novo)
  if (fs.existsSync(SNAPSHOT)) {
    try {
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
      if (snap.v === DATA_VERSION) {
        for (const [day, events] of Object.entries(snap.days)) {
          for (const e of events) learnLeague(e);
          mem.set(day, { at: Date.now(), events });
        }
      }
    } catch (e) { console.error('historico.json inválido:', e.message); }
  }
  const all = [];
  await pool(days, 6, async (day) => {
    for (const e of await fetchDay(day, Infinity)) all.push(e);
    loading.done++;
  });
  setHistory(all);
  loading.ready = true;
  console.log(`Histórico pronto: ${history.length} jogos de ${leagueCount} competições.`);
}

function buildIdx(games, mk) {
  const M = MARKETS[mk];
  const dates = [], cum = [0], cumHit = [0];
  for (const g of games) {
    if (!M.known(g)) continue;
    const [a, b] = M.get(g);
    dates.push(g.date);
    cum.push(cum[cum.length - 1] + a + b);
    cumHit.push(cumHit[cumHit.length - 1] + (M.hit(a, b) ? 1 : 0));
  }
  return { dates, cum, cumHit };
}

let backtestAt = 0;
function setHistory(list, { recalcBacktest = true } = {}) {
  const map = new Map(history.map((e) => [e.id, e]));
  for (const e of list) if (e.state === 'post' && e.done) map.set(e.id, e);
  history = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  historyIds = new Set(history.map((e) => e.id));
  byTeam = new Map(); const byLeague = new Map();
  for (const g of history) {
    for (const id of [g.home.id, g.away.id]) { if (!byTeam.has(id)) byTeam.set(id, []); byTeam.get(id).push(g); }
    if (!byLeague.has(g.league)) byLeague.set(g.league, []); byLeague.get(g.league).push(g);
  }
  leagueCount = byLeague.size;
  // liga "tem cartões" se a fonte registra cartão na maioria dos jogos dela (senão os zeros são falta de dado)
  cardLeagues = new Set();
  for (const [lg, games] of byLeague) {
    const withDet = games.filter((g) => g.cardsH != null);
    if (withDet.length >= 5 && withDet.filter((g) => g.cardsH + g.cardsA > 0).length / withDet.length >= 0.85) cardLeagues.add(lg);
  }
  for (const mk of MKEYS) {
    leagueIdx[mk] = new Map([...byLeague].map(([k, v]) => [k, buildIdx(v, mk)]));
    globalIdx[mk] = buildIdx(history, mk);
  }
  // o teste no passado é o passo pesado: refaz no máximo a cada 6 h (o servidor grátis é lento)
  if (recalcBacktest || Date.now() - backtestAt > 6 * 3600000) {
    for (const mk of MKEYS) backtest[mk] = runBacktest(mk);
    backtestAt = Date.now();
  }
}

// quantos itens de idx têm data < beforeDate (busca binária)
function countBefore(idx, beforeDate) {
  let lo = 0, hi = idx.dates.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (idx.dates[mid] < beforeDate) lo = mid + 1; else hi = mid; }
  return lo;
}

// ---------- modelo ----------
function teamStats(mk, teamId, beforeDate) {
  const M = MARKETS[mk];
  const games = byTeam.get(teamId) || [];
  const out = [];
  for (let i = games.length - 1; i >= 0 && out.length < RECENT_GAMES; i--) {
    const g = games[i];
    if (g.date >= beforeDate || !M.known(g)) continue;
    const [h, a] = M.get(g);
    const hit = M.hit(h, a);
    if (g.home.id === teamId) out.push({ home: true, f: h, a, t: h + a, hit });
    else out.push({ home: false, f: a, a: h, t: h + a, hit });
  }
  return out;
}

const DEFAULTS = { ht: [0.55, 0.7], cards: [2.2, 0.75], corners: [4.8, 0.55], btts: [1.35, 0.5] };

function leagueAvg(mk, league, beforeDate) {
  for (const idx of [leagueIdx[mk] && leagueIdx[mk].get(league), globalIdx[mk]]) {
    if (!idx) continue;
    const n = countBefore(idx, beforeDate);
    if (n >= 30) return { perTeam: idx.cum[n] / n / 2, hit: idx.cumHit[n] / n };
  }
  return { perTeam: DEFAULTS[mk][0], hit: DEFAULTS[mk][1] };
}

function predict(mk, match, beforeDate) {
  const M = MARKETS[mk];
  if (mk === 'cards' && !cardLeagues.has(match.league)) return null;
  const sh = teamStats(mk, match.home.id, beforeDate);
  const sa = teamStats(mk, match.away.id, beforeDate);
  if (sh.length < MIN_GAMES || sa.length < MIN_GAMES) return null;
  const L = leagueAvg(mk, match.league, beforeDate);
  const mu = Math.max(0.2, L.perTeam);
  const shr = (sum, n, prior) => (sum + SHRINK * prior) / (n + SHRINK);
  // dá peso extra aos jogos no mesmo mando (casa em casa, fora fora)
  const venueBlend = (arr, home, key) => {
    const allR = shr(arr.reduce((s, x) => s + x[key], 0), arr.length, mu);
    const v = arr.filter((x) => x.home === home);
    if (v.length < 4) return allR;
    return 0.5 * allR + 0.5 * shr(v.reduce((s, x) => s + x[key], 0), v.length, mu);
  };
  const attH = venueBlend(sh, true, 'f'), defH = venueBlend(sh, true, 'a');
  const attA = venueBlend(sa, false, 'f'), defA = venueBlend(sa, false, 'a');
  const lamH = (attH * defA) / mu, lamA = (attA * defH) / mu;
  const lam = lamH + lamA;
  const rate = (arr) => shr(arr.filter((x) => x.hit).length, arr.length, L.hit);
  const avg = (arr) => arr.reduce((s, x) => s + x.t, 0) / arr.length;
  const raw = 0.6 * M.model(lamH, lamA) + 0.4 * (rate(sh) + rate(sa)) / 2;
  return {
    raw, lam, lamH, lamA, pNext: M.next(lamH, lamA),
    rateHome: rate(sh), rateAway: rate(sa), avgHome: avg(sh), avgAway: avg(sa), nHome: sh.length, nAway: sa.length,
  };
}

// Teste no passado, honesto: calibra com os 70% mais antigos e mede o acerto nos 30% mais recentes.
function runBacktest(mk) {
  const M = MARKETS[mk];
  const rows = [];
  for (const g of history) {
    if (!M.known(g)) continue;
    const p = predict(mk, g, g.date);
    if (!p) continue;
    const [a, b] = M.get(g);
    rows.push({ p: p.raw, hit: M.hit(a, b) });
  }
  const cut = Math.floor(rows.length * 0.7);
  const binsTrain = makeBins(rows.slice(0, cut));
  const test = rows.slice(cut);
  const thresholds = (M.ths || [0.7, 0.75, 0.8, 0.85, 0.9]).map((t) => {
    const sel = test.filter((r) => calibrate(r.p, binsTrain) >= t);
    return { t, n: sel.length, acc: sel.length ? sel.filter((r) => r.hit).length / sel.length : null };
  });
  const base = test.length ? test.filter((r) => r.hit).length / test.length : null;
  return { n: rows.length, nTest: test.length, base, bins: makeBins(rows), thresholds };
}

function makeBins(rows) {
  const bins = {};
  for (const r of rows) {
    const b = Math.min(19, Math.floor(r.p * 20));
    (bins[b] ||= { n: 0, hit: 0 });
    bins[b].n++; bins[b].hit += r.hit;
  }
  return bins;
}

function calibrate(raw, bins) {
  const b = bins && bins[Math.min(19, Math.floor(raw * 20))];
  if (!b || b.n < 15) return raw;
  const k = 30; // mistura o observado com o bruto quando a faixa tem poucos jogos
  return (b.hit + k * raw) / (b.n + k);
}

// ---------- ao vivo ----------
function liveMinute(m) {
  const base = parseInt(m.clock, 10);
  if (!isNaN(base)) return base;
  return m.period >= 2 ? 46 : 0;
}

function liveProb(mk, m, p, prob) {
  const M = MARKETS[mk];
  const halftime = m.statusName === 'STATUS_HALFTIME';
  if (mk === 'ht') {
    const total = m.scoreH + m.scoreA;
    const firstHalfLive = m.state === 'in' && !halftime && (m.period || 1) <= 1;
    // durante o 1º tempo, qualquer gol no placar é gol do 1º tempo (não depende do minuto vir na fonte)
    const goals1 = firstHalfLive ? total : m.h1Home + m.h1Away;
    if (m.state === 'post' || halftime || (m.state === 'in' && m.period >= 2)) {
      if (total === 0) return { status: 'red', now: 0 };
      if (!m.reliable) return null; // a fonte não diz o minuto dos gols → não dá para afirmar o resultado
      return { status: goals1 > 0 ? 'green' : 'red', now: goals1 };
    }
    if (m.state !== 'in') return null;
    if (goals1 > 0) return { status: 'green', now: goals1, p: 1 };
    const minute = Math.min(45, liveMinute(m));
    const lamFull = -Math.log(1 - Math.min(prob, 0.995)); // usa a chance calibrada
    return { status: 'live', now: 0, minute, p: 1 - Math.exp(-lamFull * (Math.max(0, 45 - minute) + 2) / 45) };
  }
  if (mk === 'btts') {
    const h = m.scoreH, a = m.scoreA, now = `${h}-${a}`;
    if (m.state === 'post') return M.known(m) ? { status: M.hit(h, a) ? 'green' : 'red', now } : null;
    if (m.state !== 'in') return null;
    if (M.hit(h, a)) return { status: 'green', now, p: 1 };
    const minute = Math.min(90, liveMinute(m));
    const rem = (Math.max(0, 90 - minute) + 4) / 94;
    const pH = h > 0 ? 1 : 1 - Math.exp(-p.lamH * rem), pA = a > 0 ? 1 : 1 - Math.exp(-p.lamA * rem);
    return { status: 'live', now, minute, p: pH * pA };
  }
  const [a, b] = M.get(m);
  // jogo encerrado: só com dado confiável (sem prorrogação etc.); ao vivo: o que a fonte já marcou
  const known = m.state === 'post' ? M.known(m) : (a != null && b != null && (mk !== 'cards' || cardLeagues.has(m.league)));
  const now = known ? a + b : null;
  if (m.state === 'post') return now == null ? null : { status: now > M.line ? 'green' : 'red', now };
  if (m.state !== 'in') return null;
  if (now == null) return { status: 'live', now: null, p: prob };
  if (now > M.line) return { status: 'green', now, p: 1 };
  const minute = Math.min(90, liveMinute(m));
  const rem = (Math.max(0, 90 - minute) + 4) / 94;
  return { status: 'live', now, minute, p: pOver(p.lam * rem, M.line - now) };
}

// ---------- jogos de hoje / próximos ----------
let lastMerge = 0;
async function currentMatches() {
  const today = new Date();
  const out = [];
  await pool([-1, 0, 1, 2, 3], 5, async (n) => {
    const evs = await fetchDay(ymd(addDays(today, n)), n <= 0 ? 25000 : 10 * 60000);
    for (const e of evs) out.push(e);
  });
  // jogos que terminaram entram no histórico (no máximo a cada 30 min, para não pesar no servidor)
  if (loading.ready && Date.now() - lastMerge > 30 * 60000) {
    const finished = out.filter((e) => e.state === 'post' && e.done && !historyIds.has(e.id));
    if (finished.length) setHistory(finished, { recalcBacktest: false });
    lastMerge = Date.now();
  }

  const now = Date.now();
  const seen = new Set();
  const list = [];
  for (const m of out) {
    if (seen.has(m.id)) continue; seen.add(m.id);
    if (m.state === 'post' && !m.done) continue; // adiado, cancelado, abandonado
    const t = new Date(m.date).getTime();
    const relevant = m.state === 'in' || (m.state === 'pre' && t < now + 3 * 86400000) ||
      (m.state === 'post' && now - t < 6 * 3600000);
    if (!relevant) continue;
    const markets = {};
    for (const mk of MKEYS) {
      const p = predict(mk, m, m.date);
      if (!p) continue;
      const prob = calibrate(p.raw, backtest[mk] && backtest[mk].bins);
      markets[mk] = {
        prob, lam: p.lam, pNext: p.pNext, rateHome: p.rateHome, rateAway: p.rateAway,
        avgHome: p.avgHome, avgAway: p.avgAway, nHome: p.nHome, nAway: p.nAway,
        live: liveProb(mk, m, p, prob),
      };
    }
    if (!Object.keys(markets).length) continue;
    const { reliable, ...rest } = m;
    list.push({ ...rest, leagueName: leagueName(m.league), markets });
  }
  list.sort((a, b) => a.date.localeCompare(b.date));
  return list;
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
let cached = { at: 0, data: null };

function statusPayload() {
  const bt = {};
  for (const mk of MKEYS) {
    const b = backtest[mk];
    if (b) bt[mk] = { n: b.n, nTest: b.nTest, base: b.base, thresholds: b.thresholds };
  }
  return { loading, ligas: leagueCount, markets: Object.fromEntries(MKEYS.map((k) => [k, { label: MARKETS[k].label, line: MARKETS[k].line }])), backtest: bt };
}

function startServer() {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/status') return send(res, 200, statusPayload());
      if (url.pathname === '/api/jogos') {
        if (!loading.ready) return send(res, 200, { loading, jogos: [] });
        if (Date.now() - cached.at > 15000) cached = { at: Date.now(), data: await currentMatches() };
        return send(res, 200, { loading, jogos: cached.data, atualizado: new Date(cached.at).toISOString() });
      }
      const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
      // no-cache: o celular sempre pega a versão nova da página depois de uma atualização
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
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

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

if (require.main === module) startServer();
module.exports = { DATA_VERSION, loadHistory, predict, statusPayload, getBacktest: () => backtest, MARKETS };
