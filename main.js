const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAKRVJVLPfTV9CVMGeSB5pt0Bd0k13OFVU',
  authDomain: 'database-deff8.firebaseapp.com',
  databaseURL: 'https://database-deff8-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'database-deff8',
  storageBucket: 'database-deff8.firebasestorage.app',
  messagingSenderId: '532508144546',
  appId: '1:532508144546:web:e48d1d84f0a47550ad38fb',
};

const ROOM_CODE_KEY = 'arise-room-code';
const PLAYER_NAME_KEY = 'arise-player-name';

const state = {
  error: '',
  statusMessage: '',
  playerName: localStorage.getItem(PLAYER_NAME_KEY) || 'Jugador',
  roomCode: sessionStorage.getItem(ROOM_CODE_KEY) || '',
  joinCode: '',
  selectedThemes: [],
  room: null,
  currentUser: null,
  busyAction: '',
  themes: null,
};

let auth = null;
let database = null;
let roomListenerRef = null;
let roomListenerCallback = null;
let presenceInterval = null;
let uiClockInterval = null;
let botActionLock = false;

const BOT_NAME_POOL = ['Nova', 'Pixel', 'Atlas', 'Mika', 'Echo', 'Runa', 'Vega', 'Kiro', 'Luma', 'Moss'];

init();

async function init() {
  try {
    const themesResponse = await fetch('themes.json', { cache: 'no-store' });
    if (!themesResponse.ok) throw new Error('No se pudo cargar themes.json');
    state.themes = await themesResponse.json();
    state.selectedThemes = [...state.themes.order];

    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    database = firebase.database();
    await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);

    auth.onAuthStateChanged((user) => {
      state.currentUser = user;
      render();
    });

    await signInAnonymously();
    attachRoomListener();
    startPresenceLoop();
    startUiClockLoop();
  } catch (error) {
    state.error = error.message || 'No se pudo iniciar Firebase.';
  } finally {
    render();
  }
}

async function signInAnonymously() {
  if (!auth.currentUser) {
    await auth.signInAnonymously();
  }
}

function getUserId() {
  return state.currentUser?.uid || '';
}

function getRoom() {
  return state.room?.meta ? state.room : null;
}

function orderedPlayers(playersMap = {}) {
  return Object.entries(playersMap)
    .map(([id, player]) => ({ id, ...player }))
    .sort((left, right) => (left.joinedAt || 0) - (right.joinedAt || 0));
}

function isBotPlayer(player) {
  return Boolean(player?.isBot) || String(player?.id || '').startsWith('bot-');
}

function getUniqueBotName(existingNames) {
  const available = BOT_NAME_POOL.filter((name) => !existingNames.has(name));
  if (!available.length) {
    return `Bot ${existingNames.size + 1}`;
  }
  return available[Math.floor(Math.random() * available.length)];
}

function scoreDelta(statementType, vote) {
  if (statementType === 'lie' && vote === 'lie') return -1;
  if (statementType === 'lie' && vote === 'truth') return 2;
  if (statementType === 'truth' && vote === 'lie') return 1;
  return 0;
}

function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function normalizeName(name) {
  return String(name || '').trim().slice(0, 24) || 'Jugador';
}

function pickItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function buildRound(roomMeta, playersList, roundIndex) {
  const themeKey = roomMeta.selectedThemes[roundIndex % roomMeta.selectedThemes.length];
  const theme = state.themes.themes[themeKey];
  const speaker = playersList[roundIndex % playersList.length];
  return {
    roundId: `round-${roundIndex + 1}`,
    index: roundIndex + 1,
    speakerId: speaker.id,
    themeKey,
    themeLabel: theme.label,
    themePrompt: theme.prompt,
    truthText: pickItem(theme.truths),
    lieText: pickItem(theme.lies),
    chosenType: null,
    chosenText: '',
    votes: {},
    requiredVotes: Math.max(playersList.length - 1, 0),
    status: 'prompt',
    result: null,
  };
}

function getStatusLabel(status) {
  const labels = {
    lobby: 'Sala',
    prompt: 'Eligiendo...',
    vote: 'Votando...',
    reveal: 'Revelando...',
    finished: 'Finalizada',
  };

  return labels[status] || status || '—';
}

function formatElapsedTime(startedAt) {
  const elapsedMs = Math.max(0, Date.now() - Number(startedAt || 0));
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatWinnerNames(winners) {
  const names = winners.map((player) => escapeHtml(player.name)).filter(Boolean);
  if (names.length <= 1) return names[0] || 'sin ganador';
  if (names.length === 2) return `${names[0]} y ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

function render() {
  document.getElementById('app').innerHTML = template();
  wireEvents();
}

function template() {
  const room = getRoom();
  const meta = room?.meta || null;
  const players = orderedPlayers(room?.players || {});
  const currentUserId = getUserId();
  const currentScores = meta?.scores || {};
  const currentRound = meta?.currentRound || null;
  const isHost = Boolean(meta && currentUserId && meta.hostId === currentUserId);
  const hasRoom = Boolean(state.roomCode && room);
  const scoreboard = players
    .map((player) => ({ ...player, score: currentScores[player.id] || 0 }))
    .sort((left, right) => right.score - left.score || left.joinedAt - right.joinedAt);
  const topScore = scoreboard[0]?.score || 0;
  const winners = scoreboard.filter((player) => player.score === topScore);

  if (!state.themes) {
    return `<main class="app-shell"><section class="panel"><div class="panel-inner">Cargando...</div></section></main>`;
  }

  return `
    <main class="app-shell">
      <header class="topbar">
        <div class="brand-block">
          <h1>Verdad rara. Mentira plausible.</h1>
        </div>
      </header>
      ${!hasRoom ? landingTemplate() : meta?.status === 'lobby' ? lobbyTemplate(meta, players, scoreboard) : meta?.status === 'finished' ? finishedTemplate(meta, scoreboard, winners, topScore) : gameTemplate(meta, players, currentRound, scoreboard, isHost, currentUserId)}
    </main>
  `;

  function landingTemplate() {
    return `
      <div class="layout landing-layout">
        <div class="panel-stack">
          <section class="panel card-surface">
            <div class="panel-inner stack">
              <form id="create-form" class="form-grid">
                <label class="field"><span>Jugador</span><input name="playerName" value="${escapeHtml(state.playerName)}" maxlength="24" /></label>
                <button class="primary-button" type="submit" ${state.busyAction === 'createRoom' ? 'disabled' : ''}>Crear sala</button>
              </form>
            </div>
          </section>
          <section class="panel card-surface">
            <div class="panel-inner stack">
              <form id="join-form" class="form-grid">
                <label class="field"><span>Jugador</span><input name="playerName" value="${escapeHtml(state.playerName)}" maxlength="24" /></label>
                <label class="field"><span>Código</span><input name="joinCode" value="${escapeHtml(state.joinCode)}" maxlength="5" placeholder="ABCDE" /></label>
                <button class="secondary-button" type="submit" ${state.busyAction === 'joinRoom' ? 'disabled' : ''}>Unirse a sala</button>
              </form>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function lobbyTemplate(meta, players, scoreboard) {
    const hostSelectedThemes = meta.selectedThemes || [];
    const canEditThemes = isHost && meta.status === 'lobby';
    const canStartGame = isHost && players.length >= 4 && state.busyAction !== 'startGame';
    return `
      <div class="layout game-layout">
        <section class="panel sidebar-panel">
          <div class="panel-inner stack">
            <div class="room-code-block"><span>Código</span><strong>${state.roomCode}</strong></div>
            <div class="summary-grid">
              <div class="stat-card"><span>Rondas</span><strong>${meta.roundsTotal}</strong></div>
              <div class="stat-card"><span>Temas</span><strong>${meta.selectedThemes?.length || 0}</strong></div>
              <div class="stat-card"><span>Jugadores</span><strong>${players.length}</strong></div>
            </div>
            <div class="card-surface soft-card">
              <p class="card-title">Jugadores</p>
              <div class="player-list">${scoreboard.map((player) => `<div class="player-row"><span>${escapeHtml(player.name)}${player.id === meta.hostId ? ' · Host' : ''}</span><strong>${player.score} pts</strong></div>`).join('')}</div>
            </div>
            <button type="button" class="secondary-button" data-action="copy-code">Copiar Código</button>
            <button type="button" class="ghost-button" data-action="leave-room">Salir</button>
          </div>
        </section>
        <section class="panel main-panel">
          <div class="panel-inner stack">
            <div class="card-head"><div><p class="card-title">Temas</p></div></div>
            ${canEditThemes ? roundsSliderTemplate(meta.roundsTotal) : ''}
            ${canEditThemes ? themeChecklistTemplate(hostSelectedThemes) : `<div class="soft-card"><p class="card-note">Temas seleccionados por el host:</p><p>${hostSelectedThemes.map((themeKey) => state.themes.themes[themeKey]?.label).join(', ')}</p></div>`}
            ${isHost ? `<div class="button-row"><button type="button" class="primary-button" data-action="start-game" ${!canStartGame ? 'disabled' : ''}>${state.busyAction === 'startGame' ? 'Iniciando...' : 'Empezar Partida'}</button></div>` : ''}
          </div>
        </section>
      </div>
    `;
  }

  function roundsSliderTemplate(roundsTotal) {
    return `
      <div class="soft-card rounds-card">
        <label class="field">
          <span>Rondas</span>
          <input type="range" name="roundsTotal" min="1" max="10" step="1" value="${roundsTotal || 6}" data-rounds-slider />
          <small class="range-value">${roundsTotal || 6} rondas</small>
        </label>
      </div>
    `;
  }

  function themeChecklistTemplate(selectedThemes) {
    return `
      <div class="theme-checklist">
        ${state.themes.order.map((key) => {
          const theme = state.themes.themes[key];
          const checked = selectedThemes.includes(key);
          return `
            <label class="theme-check ${checked ? 'active' : ''}">
              <input type="checkbox" data-theme-toggle value="${key}" ${checked ? 'checked' : ''} />
              <span class="theme-check-box">
                <strong>${theme.label}</strong>
                <small>${theme.prompt}</small>
              </span>
            </label>
          `;
        }).join('')}
      </div>
    `;
  }

  function gameTemplate(meta, players, currentRound, scoreboard, isHost, currentUserId) {
    return `
      <div class="layout game-layout">
        <section class="panel sidebar-panel">
          <div class="panel-inner stack">
            <div class="room-code-block"><span>Código</span><strong>${state.roomCode}</strong></div>
            <div class="summary-grid">
              <div class="stat-card"><span>Ronda</span><strong>${meta.currentRoundIndex || 0}</strong></div>
              <div class="stat-card"><span>Tiempo</span><strong>${formatElapsedTime(meta.startedAt)}</strong></div>
              <div class="stat-card"><span>Puntos</span><strong>${currentScores[currentUserId] || 0}</strong></div>
            </div>
            <div class="card-surface soft-card"><p class="card-title">Marcador</p><div class="player-list">${scoreboard.map((player) => `<div class="player-row"><span>${escapeHtml(player.name)}</span><strong>${player.score} pts</strong></div>`).join('')}</div></div>
            <button type="button" class="secondary-button" data-action="copy-code">Copiar Código</button>
            <button type="button" class="ghost-button" data-action="leave-room">Salir</button>
          </div>
        </section>
        <section class="panel main-panel">
          <div class="panel-inner stack">
            <div class="card-head"><div><p class="card-title">Ronda ${currentRound?.index || 0} · ${currentRound?.themeLabel || ''}</p><p class="card-note">${currentRound?.themePrompt || ''}</p></div><span class="pill">${getStatusLabel(meta.status)}</span></div>
            ${meta.status === 'prompt' ? promptTemplate(players, currentRound) : meta.status === 'vote' ? voteTemplate(currentRound) : revealTemplate(players, currentRound, isHost)}
          </div>
        </section>
      </div>
    `;
  }

  function finishedTemplate(meta, scoreboard, winners, topScore) {
    return `
      <div class="layout game-layout finished-layout">
        <section class="panel sidebar-panel finished-panel">
          <div class="panel-inner stack">
            <div class="room-code-block"><span>Resultados</span><strong>${state.roomCode}</strong></div>
            <div class="soft-card success-card">${winners.length > 1 ? `Empate entre ${formatWinnerNames(winners)} con ${topScore} puntos.` : `Ganador ${formatWinnerNames(winners)} con ${topScore} puntos.`}</div>
            <div class="leaderboard">${scoreboard.map((player) => `<div class="leaderboard-row"><span>${escapeHtml(player.name)}</span><strong>${player.score} pts</strong></div>`).join('')}</div>
            ${isHost ? '<button type="button" class="primary-button" data-action="return-lobby">Volver</button>' : ''}
          </div>
        </section>
      </div>
    `;
  }

  function promptTemplate(players, currentRound) {
    const speaker = players.find((player) => player.id === currentRound?.speakerId);
    if (currentUserId === currentRound?.speakerId) {
      return `
        <form id="statement-form" class="form-grid">
          <div class="split-grid">
            <label class="choice-card ${currentRound?.chosenType !== 'lie' ? 'active' : ''}"><input type="radio" name="statementType" value="truth" ${currentRound?.chosenType !== 'lie' ? 'checked' : ''} /><div class="choice-copy"><strong>Verdad Rara</strong><p>${escapeHtml(currentRound?.truthText || '')}</p></div></label>
            <label class="choice-card ${currentRound?.chosenType === 'lie' ? 'active' : ''}"><input type="radio" name="statementType" value="lie" ${currentRound?.chosenType === 'lie' ? 'checked' : ''} /><div class="choice-copy"><strong>Mentira Plausible</strong><p>Escribe una mentira que suene convincente.</p><textarea class="statement-input" name="customText" placeholder="Escribe o mejora tu mentira">${escapeHtml(currentRound?.lieText || '')}</textarea></div></label>
          </div>
          <button type="submit" class="primary-button" ${state.busyAction === 'submitStatement' ? 'disabled' : ''}>${state.busyAction === 'submitStatement' ? 'Publicando...' : 'Publicar Frase'}</button>
        </form>
      `;
    }
    return `<div class="soft-card">Espera a que <strong>${escapeHtml(speaker?.name || 'otro jugador')}</strong> publique la frase.</div>`;
  }

  function voteTemplate(currentRound) {
    if (currentUserId === currentRound?.speakerId) {
      return `<div class="soft-card">Tu frase está siendo votada por el resto del lobby.</div>`;
    }
    return `
      <div class="stack">
        <div class="statement-block">${escapeHtml(currentRound?.chosenText || '')}</div>
        <div class="vote-grid"><button type="button" class="truth-button" data-vote="truth">Verdad</button><button type="button" class="lie-button" data-vote="lie">Mentira</button></div>
        <div class="soft-card">Votaciones: ${Object.keys(currentRound?.votes || {}).length} / ${currentRound?.requiredVotes || 0}</div>
      </div>
    `;
  }

  function revealTemplate(players, currentRound, isHost) {
    return `
      <div class="stack">
        <div class="statement-block reveal-block">${escapeHtml(currentRound?.chosenText || '')}</div>
        <div class="soft-card"><p><strong>Tipo real:</strong> ${currentRound?.chosenType === 'truth' ? 'Verdad' : 'Mentira'}</p><p><strong>Jugador:</strong> ${escapeHtml(players.find((player) => player.id === currentRound?.speakerId)?.name || '—')}</p><p><strong>Consenso:</strong> ${currentRound?.result?.consensusVote === 'truth' ? 'Verdad' : 'Mentira'} (${currentRound?.result?.truthVotes || 0} verdad / ${currentRound?.result?.lieVotes || 0} mentira)</p><p><strong>Cambio total:</strong> ${(currentRound?.result?.totalDelta || 0) >= 0 ? '+' : ''}${currentRound?.result?.totalDelta || 0}</p></div>
        ${isHost ? `<button type="button" class="primary-button" data-action="next-round" ${state.busyAction === 'nextRound' ? 'disabled' : ''}>${state.busyAction === 'nextRound' ? 'Avanzando...' : 'Siguiente ronda'}</button>` : ''}
      </div>
    `;
  }
}

function wireEvents() {
  const createForm = document.getElementById('create-form');
  const joinForm = document.getElementById('join-form');
  const statementForm = document.getElementById('statement-form');

  if (createForm) createForm.addEventListener('submit', createRoom);
  if (joinForm) joinForm.addEventListener('submit', joinRoom);
  if (statementForm) statementForm.addEventListener('submit', submitStatement);

  document.querySelectorAll('[data-action="copy-code"]').forEach((button) => button.addEventListener('click', copyRoomCode));
  document.querySelectorAll('[data-action="leave-room"]').forEach((button) => button.addEventListener('click', leaveRoom));
  document.querySelectorAll('[data-action="return-lobby"]').forEach((button) => button.addEventListener('click', returnToLobby));
  document.querySelectorAll('[data-action="close-room"]').forEach((button) => button.addEventListener('click', closeRoom));
  document.querySelectorAll('[data-action="start-game"]').forEach((button) => button.addEventListener('click', startGame));
  document.querySelectorAll('[data-action="next-round"]').forEach((button) => button.addEventListener('click', nextRound));
  document.querySelectorAll('[data-vote]').forEach((button) => button.addEventListener('click', () => castVote(button.dataset.vote)));
  document.querySelectorAll('[data-theme-toggle]').forEach((input) => input.addEventListener('change', toggleThemeSelection));
  document.querySelectorAll('[data-rounds-slider]').forEach((input) => input.addEventListener('input', updateRoundsTotal));

  createForm?.querySelector('input[name="playerName"]')?.addEventListener('input', (event) => setPlayerName(event.target.value));
  joinForm?.querySelector('input[name="playerName"]')?.addEventListener('input', (event) => setPlayerName(event.target.value));
  joinForm?.querySelector('input[name="joinCode"]')?.addEventListener('input', (event) => { state.joinCode = event.target.value.toUpperCase(); });
}

async function toggleThemeSelection(event) {
  const checkbox = event.currentTarget;
  const room = getRoom();
  if (!room?.meta || room.meta.hostId !== getUserId()) return;

  const themeKey = checkbox.value;
  const currentThemes = Array.isArray(room.meta.selectedThemes) ? [...room.meta.selectedThemes] : [];
  const nextThemes = checkbox.checked
    ? Array.from(new Set([...currentThemes, themeKey]))
    : currentThemes.filter((item) => item !== themeKey);

  if (!nextThemes.length) {
    checkbox.checked = true;
    return;
  }

  state.selectedThemes = nextThemes;
  await updateRoomMeta((meta) => {
    meta.selectedThemes = nextThemes;
    return meta;
  });
}

async function updateRoundsTotal(event) {
  const slider = event.currentTarget;
  const nextRounds = Math.max(1, Math.min(10, Number(slider.value) || 6));
  const room = getRoom();
  if (!room?.meta || room.meta.hostId !== getUserId()) return;

  slider.closest('.field')?.querySelector('.range-value')?.replaceChildren(document.createTextNode(`${nextRounds} rondas`));
  await updateRoomMeta((meta) => {
    meta.roundsTotal = nextRounds;
    return meta;
  });
}

function setPlayerName(name) {
  state.playerName = normalizeName(name);
  localStorage.setItem(PLAYER_NAME_KEY, state.playerName);
}

function attachRoomListener() {
  if (roomListenerRef && roomListenerCallback) {
    roomListenerRef.off('value', roomListenerCallback);
    roomListenerRef = null;
    roomListenerCallback = null;
  }

  if (!database || !state.roomCode) {
    state.room = null;
    return;
  }

  roomListenerRef = database.ref(`rooms/${state.roomCode}`);
  roomListenerCallback = (snapshot) => {
    if (!snapshot.exists()) {
      state.room = null;
      state.error = 'La sala no existe o se cerró.';
      render();
      return;
    }
    state.room = snapshot.val();
    state.error = '';
    render();
    void driveBotActions(state.room);
  };

  roomListenerRef.on('value', roomListenerCallback, (error) => {
    state.room = null;
    state.error = error.message || 'No se pudo leer la sala.';
    render();
  });
}

function startPresenceLoop() {
  if (presenceInterval) clearInterval(presenceInterval);
  presenceInterval = setInterval(() => {
    if (!database || !state.roomCode || !getUserId()) return;
    database.ref(`rooms/${state.roomCode}/players/${getUserId()}`).update({ lastSeenAt: Date.now() }).catch(() => {});
  }, 8000);
}

function startUiClockLoop() {
  if (uiClockInterval) clearInterval(uiClockInterval);
  uiClockInterval = setInterval(() => {
    const room = getRoom();
    if (!room?.meta || room.meta.status === 'lobby' || room.meta.status === 'finished' || !room.meta.startedAt) return;
    render();
  }, 1000);
}

async function withBusy(actionName, callback) {
  state.busyAction = actionName;
  state.error = '';
  render();
  try {
    return await callback();
  } finally {
    state.busyAction = '';
    render();
  }
}

async function createRoom(event) {
  event.preventDefault();
  if (!database || !getUserId()) return;

  await withBusy('createRoom', async () => {
    const form = event.currentTarget;
    const name = normalizeName(form.playerName.value);
    const rounds = 6;
    const themes = [...state.themes.order];
    const code = randomRoomCode();
    const roomRef = database.ref(`rooms/${code}`);
    const initialRoom = {
      meta: {
        code,
        hostId: getUserId(),
        hostName: name,
        status: 'lobby',
        roundsTotal: rounds,
        currentRoundIndex: 0,
        selectedThemes: themes.length ? themes : [...state.themes.order],
        currentRound: null,
        history: [],
        scores: { [getUserId()]: 0 },
        playerOrder: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      players: {
        [getUserId()]: { name, isHost: true, joinedAt: Date.now(), lastSeenAt: Date.now() },
      },
    };

    await roomRef.set(initialRoom);
    state.roomCode = code;
    sessionStorage.setItem(ROOM_CODE_KEY, code);
    attachRoomListener();
  });
}

async function joinRoom(event) {
  event.preventDefault();
  if (!database || !getUserId()) return;

  await withBusy('joinRoom', async () => {
    const form = event.currentTarget;
    const code = String(form.joinCode.value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) {
      state.error = 'El código debe tener 5 caracteres.';
      render();
      return;
    }

    const roomRef = database.ref(`rooms/${code}`);
    const snapshot = await roomRef.once('value');

    if (!snapshot.exists() || !snapshot.val()?.meta) {
      state.error = 'La sala no existe.';
      render();
      return;
    }

    const roomValue = snapshot.val();
    const meta = roomValue.meta;
    const players = roomValue.players || {};
    const alreadyMember = Boolean(players[getUserId()]);

    if (meta.status !== 'lobby' && !alreadyMember) {
      state.error = 'La partida ya empezó.';
      render();
      return;
    }

    const playerName = normalizeName(form.playerName.value);
    const joinedAt = players[getUserId()]?.joinedAt || Date.now();

    await roomRef.update({
      players: {
        ...players,
        [getUserId()]: {
          name: playerName,
          isHost: meta.hostId === getUserId(),
          joinedAt,
          lastSeenAt: Date.now(),
        },
      },
      meta: {
        ...meta,
        updatedAt: Date.now(),
        scores: {
          ...(meta.scores || {}),
          [getUserId()]: typeof meta.scores?.[getUserId()] === 'number' ? meta.scores[getUserId()] : 0,
        },
      },
    });

    state.roomCode = code;
    sessionStorage.setItem(ROOM_CODE_KEY, code);
    attachRoomListener();
  });
}

async function updateRoomMeta(mutator) {
  if (!database || !state.roomCode) return;
  await database.ref(`rooms/${state.roomCode}/meta`).transaction((meta) => {
    if (!meta) return meta;
    const nextMeta = mutator({ ...meta });
    nextMeta.updatedAt = Date.now();
    return nextMeta;
  });
}

async function startGame() {
  const room = getRoom();
  if (!database || !state.roomCode || !room?.meta || room.meta.hostId !== getUserId()) return;

  await withBusy('startGame', async () => {
    const playersList = orderedPlayers(room.players || {});
    if (playersList.length < 4) {
      state.error = 'Necesitas al menos 4 jugadores.';
      render();
      return;
    }

    const playerOrder = playersList.map((player) => player.id);
    const firstRound = buildRound(room.meta, playersList, 0);
    const scores = { ...(room.meta.scores || {}) };
    playerOrder.forEach((playerId) => {
      if (typeof scores[playerId] !== 'number') scores[playerId] = 0;
    });

    await database.ref(`rooms/${state.roomCode}`).update({
      meta: {
        ...room.meta,
        status: 'prompt',
        currentRoundIndex: 1,
        playerOrder,
        currentRound: firstRound,
        scores,
        history: [],
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
  });
}

async function submitStatement(event) {
  event.preventDefault();
  const room = getRoom();
  if (!database || !state.roomCode || !room?.meta || !room.meta.currentRound) return;

  const form = event.currentTarget;
  const statementType = form.statementType.value === 'lie' ? 'lie' : 'truth';
  const customText = String(form.customText.value || '').trim();

  await withBusy('submitStatement', async () => {
    await updateRoomMeta((meta) => {
      if (meta.status !== 'prompt' || meta.currentRound?.speakerId !== getUserId()) return meta;

      const nextRound = {
        ...meta.currentRound,
        chosenType: statementType,
        chosenText: statementType === 'lie' ? (customText || meta.currentRound.lieText) : meta.currentRound.truthText,
        status: 'vote',
        votes: {},
        updatedAt: Date.now(),
      };

      meta.currentRound = nextRound;
      meta.status = 'vote';
      return meta;
    });
  });
}

async function castVote(vote) {
  const room = getRoom();
  if (!database || !state.roomCode || !room?.meta?.currentRound) return;

  await withBusy('castVote', async () => {
    await updateRoomMeta((meta) => {
      return applyVoteToMeta(meta, getUserId(), vote, room.players || {});
    });
  });
}

async function nextRound() {
  const room = getRoom();
  if (!database || !state.roomCode || !room?.meta || room.meta.hostId !== getUserId()) return;

  await withBusy('nextRound', async () => {
    await updateRoomMeta((meta) => {
      if (meta.status !== 'reveal') return meta;

      const nextIndex = Number(meta.currentRoundIndex || 0);
      if (nextIndex >= Number(meta.roundsTotal || 0)) {
        meta.status = 'finished';
        meta.currentRound = null;
        return meta;
      }

      const playersList = orderedPlayers(room.players || {});
      const playerOrder = meta.playerOrder && meta.playerOrder.length ? meta.playerOrder : playersList.map((player) => player.id);
      const ordered = playerOrder.map((playerId) => playersList.find((player) => player.id === playerId)).filter(Boolean);
      const round = buildRound(meta, ordered.length ? ordered : playersList, nextIndex);

      meta.currentRoundIndex = nextIndex + 1;
      meta.currentRound = round;
      meta.status = 'prompt';
      return meta;
    });
  });
}

async function closeRoom() {
  const room = getRoom();
  if (!database || !state.roomCode || !room?.meta || room.meta.hostId !== getUserId()) return;

  await withBusy('closeRoom', async () => {
    await database.ref(`rooms/${state.roomCode}/meta`).update({
      status: 'finished',
      currentRound: null,
      startedAt: null,
      updatedAt: Date.now(),
    });
  });
}

async function returnToLobby() {
  const room = getRoom();
  if (!database || !state.roomCode || !room?.meta || room.meta.hostId !== getUserId()) return;

  await withBusy('returnLobby', async () => {
    const playersList = orderedPlayers(room.players || {});
    const resetScores = {};
    playersList.forEach((player) => {
      resetScores[player.id] = 0;
    });

    await database.ref(`rooms/${state.roomCode}`).update({
      meta: {
        ...room.meta,
        status: 'lobby',
        currentRoundIndex: 0,
        currentRound: null,
        playerOrder: [],
        history: [],
        scores: resetScores,
        startedAt: null,
        updatedAt: Date.now(),
      },
    });
  });
}

async function addBotsToRoom() {
  const room = getRoom();
  if (!database || !state.roomCode || !room?.meta || room.meta.hostId !== getUserId() || room.meta.status !== 'lobby') return;

  await withBusy('addBots', async () => {
    const players = room.players || {};
    const botsNeeded = 3;

    const existingNames = new Set(Object.values(players).map((player) => player.name));
    const nextPlayers = { ...players };
    const nextScores = { ...(room.meta.scores || {}) };

    for (let index = 0; index < botsNeeded; index += 1) {
      const botId = `bot-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
      const botName = getUniqueBotName(existingNames);
      existingNames.add(botName);
      nextPlayers[botId] = {
        name: botName,
        isBot: true,
        joinedAt: Date.now() + index,
        lastSeenAt: Date.now(),
      };
      nextScores[botId] = 0;
    }

    await database.ref(`rooms/${state.roomCode}`).update({
      players: nextPlayers,
      meta: {
        ...room.meta,
        scores: nextScores,
        updatedAt: Date.now(),
      },
    });
  });
}

function applyVoteToMeta(meta, voterId, vote, roomPlayers) {
  if (meta.status !== 'vote' || !meta.currentRound) return meta;
  if (meta.currentRound.speakerId === voterId) return meta;

  const round = { ...meta.currentRound };
  round.votes = { ...(round.votes || {}), [voterId]: vote };
  const playersList = orderedPlayers(roomPlayers || {});
  const requiredVotes = Math.max(playersList.length - 1, 0);
  const voteCount = Object.keys(round.votes).length;

  if (voteCount < requiredVotes) {
    meta.currentRound = { ...round, requiredVotes, status: 'vote', updatedAt: Date.now() };
    return meta;
  }

  return resolveRound(meta, roomPlayers, { ...round, requiredVotes, status: 'vote' });
}

function resolveRound(meta, roomPlayers, roundOverride) {
  const round = roundOverride || meta.currentRound;
  if (!round) return meta;

  const playersList = orderedPlayers(roomPlayers || {});
  const voteSummary = { truth: 0, lie: 0 };

  playersList.forEach((player) => {
    if (player.id === round.speakerId) return;
    const playerVote = round.votes[player.id];
    if (playerVote === 'truth' || playerVote === 'lie') {
      voteSummary[playerVote] += 1;
    }
  });

  const consensusVote = voteSummary.lie > voteSummary.truth ? 'lie' : 'truth';
  const totalDelta = scoreDelta(round.chosenType, consensusVote);

  const speaker = playersList.find((player) => player.id === round.speakerId);
  const scores = { ...(meta.scores || {}) };
  scores[round.speakerId] = (scores[round.speakerId] || 0) + totalDelta;

  meta.currentRound = {
    ...round,
    status: 'reveal',
    result: {
      speakerName: speaker?.name || 'Jugador',
      consensusVote,
      truthVotes: voteSummary.truth,
      lieVotes: voteSummary.lie,
      totalDelta,
    },
    updatedAt: Date.now(),
  };
  meta.scores = scores;
  meta.history = [
    {
      roundId: round.roundId,
      index: round.index,
      speakerId: round.speakerId,
      speakerName: speaker?.name || 'Jugador',
      themeKey: round.themeKey,
      themeLabel: round.themeLabel,
      chosenType: round.chosenType,
      chosenText: round.chosenText,
      consensusVote,
      truthVotes: voteSummary.truth,
      lieVotes: voteSummary.lie,
      totalDelta,
      revealedAt: Date.now(),
    },
    ...(meta.history || []),
  ];
  meta.status = 'reveal';
  return meta;
}

async function driveBotActions(roomValue) {
  if (botActionLock || !roomValue?.meta || roomValue.meta.hostId !== getUserId()) return;

  const meta = roomValue.meta;
  const players = roomValue.players || {};
  const round = meta.currentRound;
  if (!round) return;

  if (meta.status === 'prompt' && isBotPlayer(players[round.speakerId])) {
    botActionLock = true;
    try {
      const theme = state.themes.themes[round.themeKey];
      const chooseLie = Math.random() < 0.5;
      await updateRoomMeta((currentMeta) => {
        if (currentMeta.status !== 'prompt' || currentMeta.currentRound?.speakerId !== round.speakerId) return currentMeta;

        currentMeta.currentRound = {
          ...currentMeta.currentRound,
          chosenType: chooseLie ? 'lie' : 'truth',
          chosenText: chooseLie ? pickItem(theme.lies) : currentMeta.currentRound.truthText,
          status: 'vote',
          votes: {},
          updatedAt: Date.now(),
        };
        currentMeta.status = 'vote';
        return currentMeta;
      });
    } finally {
      botActionLock = false;
    }
    return;
  }

  if (meta.status === 'vote') {
    const nextBot = orderedPlayers(players).find((player) => isBotPlayer(player) && player.id !== round.speakerId && !round.votes?.[player.id]);
    if (!nextBot) return;

    botActionLock = true;
    try {
      await updateRoomMeta((currentMeta) => applyVoteToMeta(currentMeta, nextBot.id, Math.random() < 0.5 ? 'truth' : 'lie', players));
    } finally {
      botActionLock = false;
    }
  }
}

async function leaveRoom() {
  const userId = getUserId();
  if (database && state.roomCode && userId) {
    const roomId = state.roomCode;
    const roomRef = database.ref(`rooms/${roomId}`);
    const cleanup = {
      [`players/${userId}`]: null,
      [`meta/scores/${userId}`]: null,
      [`meta/currentRound/votes/${userId}`]: null,
    };

    await roomRef.update(cleanup).catch(() => {});
  }
  state.roomCode = '';
  sessionStorage.removeItem(ROOM_CODE_KEY);
  state.room = null;
  state.error = '';
  state.statusMessage = '';
  attachRoomListener();
  render();
  setTimeout(() => {
    window.location.replace(new URL('./index.html', window.location.href).href);
  }, 1000);
}

function copyRoomCode() {
  navigator.clipboard.writeText(state.roomCode).then(() => {
    state.statusMessage = `Código ${state.roomCode} copiado.`;
    render();
  }).catch(() => {
    state.statusMessage = `Código de sala: ${state.roomCode}`;
    render();
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
