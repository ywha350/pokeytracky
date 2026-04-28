import './style.css';

const ANTE = 1;
const INITIAL_STACK = 200;
const MIN_OPEN_BET = 1;
const VALUE_ANIMATION_DURATION = 420;
const chipOptions = [
  { label: '+1', value: 1 },
  { label: '+5', value: 5 },
  { label: '+10', value: 10 },
  { label: '+50', value: 50 },
];
const animatedNumberState = {
  frameId: null,
  entries: {},
};
const GAME_DB_NAME = 'pokeytracky-db';
const GAME_STORE_NAME = 'game_state';
const GAME_STATE_KEY = 'current';
let gameDbPromise = null;
let persistWritePromise = Promise.resolve();
let persistQueued = false;
let hasHydratedState = false;
let audioContext = null;
let audioUnlocked = false;
let lastMoneySignature = null;

function getAudioContext() {
  if (!window.AudioContext && !window.webkitAudioContext) {
    return null;
  }

  if (!audioContext) {
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    audioContext = new AudioContextClass();
  }

  return audioContext;
}

function unlockAudio() {
  const context = getAudioContext();
  if (!context) {
    return;
  }

  if (context.state === 'suspended') {
    context.resume().catch(() => {});
  }

  audioUnlocked = true;
}

function playTone({
  frequency,
  type = 'sine',
  duration = 0.1,
  startTime = 0,
  gain = 0.05,
  attack = 0.005,
  release = 0.08,
  frequencyEnd = frequency,
}) {
  const context = getAudioContext();
  if (!context || !audioUnlocked) {
    return;
  }

  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const now = context.currentTime + startTime;
  const stopAt = now + duration;
  const releaseStart = Math.max(now + attack, stopAt - release);

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.linearRampToValueAtTime(frequencyEnd, stopAt);

  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.linearRampToValueAtTime(gain, now + attack);
  gainNode.gain.setValueAtTime(gain, releaseStart);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, stopAt);

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(stopAt);
}

function playClickSound() {
  unlockAudio();
  playTone({
    frequency: 720,
    frequencyEnd: 560,
    type: 'triangle',
    duration: 0.06,
    gain: 0.028,
    release: 0.04,
  });
}

function playMoneySound() {
  playTone({
    frequency: 520,
    frequencyEnd: 760,
    type: 'square',
    duration: 0.07,
    gain: 0.022,
    release: 0.05,
  });
  playTone({
    frequency: 880,
    frequencyEnd: 980,
    type: 'triangle',
    duration: 0.1,
    startTime: 0.025,
    gain: 0.016,
    release: 0.06,
  });
}

function playWinnerSound() {
  [
    { frequency: 523.25, startTime: 0, duration: 0.16 },
    { frequency: 659.25, startTime: 0.08, duration: 0.18 },
    { frequency: 783.99, startTime: 0.16, duration: 0.22 },
    { frequency: 1046.5, startTime: 0.26, duration: 0.32 },
  ].forEach(({ frequency, startTime, duration }) => {
    playTone({
      frequency,
      frequencyEnd: frequency,
      type: 'triangle',
      duration,
      startTime,
      gain: 0.035,
      release: 0.12,
    });
  });
}

function getMoneySignature() {
  return JSON.stringify({
    pot: getPot(),
    players: state.players.map((player) => ({
      stack: player.stack,
      handBet: player.handBet,
      streetBet: player.streetBet,
    })),
  });
}

function syncMoneySound() {
  const signature = getMoneySignature();
  if (lastMoneySignature === null) {
    lastMoneySignature = signature;
    return;
  }

  if (signature !== lastMoneySignature) {
    playMoneySound();
    lastMoneySignature = signature;
  }
}

function createPlayer() {
  return { stack: INITIAL_STACK, handBet: 0, streetBet: 0, folded: false, acted: false };
}

function normalizePlayer(player = {}) {
  return {
    stack: Number.isFinite(player.stack) ? player.stack : INITIAL_STACK,
    handBet: Number.isFinite(player.handBet) ? player.handBet : 0,
    streetBet: Number.isFinite(player.streetBet) ? player.streetBet : 0,
    folded: Boolean(player.folded),
    acted: Boolean(player.acted),
  };
}

function getChipOptionByValue(value) {
  return chipOptions.find((chip) => chip.value === value) ?? null;
}

function serializeState() {
  return {
    players: state.players.map((player) => ({ ...player })),
    activePlayer: state.activePlayer,
    handOver: state.handOver,
    lastFullRaiseSize: state.lastFullRaiseSize,
    pendingRaiseChipValues: state.pendingRaiseChips.map((chip) => chip.value),
  };
}

function hydrateState(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.players) || snapshot.players.length !== state.players.length) {
    return false;
  }

  state.players = snapshot.players.map((player) => normalizePlayer(player));
  state.activePlayer = Number.isInteger(snapshot.activePlayer) ? snapshot.activePlayer : 0;
  if (state.activePlayer < 0 || state.activePlayer >= state.players.length) {
    state.activePlayer = 0;
  }
  state.handOver = Boolean(snapshot.handOver);
  state.lastFullRaiseSize = Number.isFinite(snapshot.lastFullRaiseSize) ? snapshot.lastFullRaiseSize : MIN_OPEN_BET;
  state.pendingRaiseChips = Array.isArray(snapshot.pendingRaiseChipValues)
    ? snapshot.pendingRaiseChipValues.map((value) => getChipOptionByValue(value)).filter(Boolean)
    : [];

  return true;
}

function openGameDb() {
  if (!('indexedDB' in window)) {
    return Promise.resolve(null);
  }

  if (!gameDbPromise) {
    gameDbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(GAME_DB_NAME, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(GAME_STORE_NAME)) {
          db.createObjectStore(GAME_STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(() => null);
  }

  return gameDbPromise;
}

async function loadPersistedState() {
  const db = await openGameDb();
  if (!db) {
    return null;
  }

  return new Promise((resolve) => {
    const transaction = db.transaction(GAME_STORE_NAME, 'readonly');
    const store = transaction.objectStore(GAME_STORE_NAME);
    const request = store.get(GAME_STATE_KEY);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
}

async function persistGameState() {
  const db = await openGameDb();
  if (!db) {
    return;
  }

  const snapshot = serializeState();

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(GAME_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(GAME_STORE_NAME);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    store.put(snapshot, GAME_STATE_KEY);
  }).catch(() => {});
}

function queuePersistGameState() {
  if (!hasHydratedState || persistQueued) {
    return;
  }

  persistQueued = true;
  queueMicrotask(() => {
    persistQueued = false;
    persistWritePromise = persistWritePromise.then(() => persistGameState()).catch(() => {});
  });
}

const state = {
  players: [
    createPlayer(),
    createPlayer(),
  ],
  activePlayer: 0,
  handOver: false,
  lastFullRaiseSize: 10,
  pendingRaiseChips: [],
};

function getRemaining(player) {
  return Math.max(player.stack - player.handBet, 0);
}

function getCurrentBet() {
  return Math.max(...state.players.map((player) => player.streetBet));
}

function getPot() {
  return state.players.reduce((sum, player) => sum + player.handBet, 0);
}

function getNeedToCall(player) {
  return Math.max(getCurrentBet() - player.streetBet, 0);
}

function getSelectedRaiseAmount() {
  return state.pendingRaiseChips.reduce((sum, chip) => sum + chip.value, 0);
}

function getMinimumRaiseTo(player) {
  const currentBet = getCurrentBet();
  const callAmount = getNeedToCall(player);

  if (callAmount === 0) {
    return currentBet + MIN_OPEN_BET;
  }

  return currentBet + state.lastFullRaiseSize;
}

function getMinimumRaiseAmount(player) {
  return getMinimumRaiseTo(player) - player.streetBet;
}

function getPendingRaiseAmount(player) {
  return getMinimumRaiseAmount(player) + getSelectedRaiseAmount();
}

function getPendingRaiseTo(player) {
  return player.streetBet + getPendingRaiseAmount(player);
}

function isAllIn(player) {
  return getRemaining(player) === 0 && player.handBet > 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function setAnimatedValue(key, target) {
  const entry = animatedNumberState.entries[key];

  if (!entry) {
    animatedNumberState.entries[key] = {
      value: target,
      startValue: target,
      targetValue: target,
      startedAt: 0,
      animating: false,
      direction: 0,
    };
    return target;
  }

  if (entry.targetValue !== target) {
    entry.startValue = entry.value;
    entry.targetValue = target;
    entry.startedAt = performance.now();
    entry.animating = true;
    entry.direction = Math.sign(target - entry.value);
  }

  return entry.value;
}

function getAnimatedValue(key, fallback) {
  const entry = animatedNumberState.entries[key];

  if (!entry) {
    return setAnimatedValue(key, fallback);
  }

  return entry.value;
}

function updateAnimatedNumberElements() {
  Object.entries(animatedNumberState.entries).forEach(([key, entry]) => {
    const element = document.querySelector(`[data-number-key="${key}"]`);
    if (!element) {
      return;
    }

    element.textContent = formatNumber(entry.value);
    element.classList.toggle('value-animating', entry.animating);
    element.classList.toggle('value-increasing', entry.animating && entry.direction > 0);
    element.classList.toggle('value-decreasing', entry.animating && entry.direction < 0);
  });
}

function stepAnimatedValues(timestamp) {
  let hasActiveAnimation = false;

  Object.values(animatedNumberState.entries).forEach((entry) => {
    if (!entry.animating) {
      return;
    }

    const elapsed = timestamp - entry.startedAt;
    const progress = Math.min(elapsed / VALUE_ANIMATION_DURATION, 1);
    entry.value = Math.round(entry.startValue + (entry.targetValue - entry.startValue) * progress);

    if (progress >= 1) {
      entry.value = entry.targetValue;
      entry.animating = false;
      entry.direction = 0;
      return;
    }

    hasActiveAnimation = true;
  });

  updateAnimatedNumberElements();

  if (hasActiveAnimation) {
    animatedNumberState.frameId = window.requestAnimationFrame(stepAnimatedValues);
    return;
  }

  animatedNumberState.frameId = null;
}

function ensureAnimatedValuesRunning() {
  if (animatedNumberState.frameId !== null) {
    return;
  }

  const hasActiveAnimation = Object.values(animatedNumberState.entries).some((entry) => entry.animating);
  if (!hasActiveAnimation) {
    updateAnimatedNumberElements();
    return;
  }

  animatedNumberState.frameId = window.requestAnimationFrame(stepAnimatedValues);
}

function getPlayerLabel(index) {
  return `Player ${index + 1}`;
}

function clearPendingRaise() {
  state.pendingRaiseChips = [];
}

function canSubmitRaise(player) {
  const pendingAmount = getPendingRaiseAmount(player);

  return pendingAmount > getNeedToCall(player) && pendingAmount <= getRemaining(player);
}

function canAdvanceStreet() {
  if (state.handOver) {
    return false;
  }

  const activePlayers = state.players.filter((player) => !player.folded);
  if (activePlayers.length <= 1) {
    return false;
  }

  if (activePlayers.every((player) => isAllIn(player))) {
    return true;
  }

  const currentBet = getCurrentBet();

  return activePlayers.every((player) => {
    if (isAllIn(player)) {
      return true;
    }

    return player.acted && player.streetBet === currentBet;
  });
}

function isBettingClosed() {
  return state.handOver || canAdvanceStreet();
}

function getPostedAnte(player) {
  return Math.min(player.stack, ANTE);
}

function maybeEndHand() {
  const playersInHand = state.players.filter((player) => !player.folded);
  if (playersInHand.length <= 1) {
    state.handOver = true;
  }
}

function startNextHand() {
  state.players.forEach((player) => {
    player.handBet = getPostedAnte(player);
    player.streetBet = 0;
    player.folded = false;
    player.acted = false;
  });
  state.activePlayer = 0;
  state.handOver = false;
  state.lastFullRaiseSize = MIN_OPEN_BET;
  clearPendingRaise();
}

function awardPotToWinner(winnerIndex) {
  const pot = getPot();
  state.players.forEach((player) => {
    player.stack -= player.handBet;
  });
  state.players[winnerIndex].stack += pot;
  playWinnerSound();
  startNextHand();
  render();
}

function promptForWinner() {
  const eligiblePlayers = state.players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => !player.folded);

  if (eligiblePlayers.length === 0) {
    return;
  }

  if (eligiblePlayers.length === 1) {
    awardPotToWinner(eligiblePlayers[0].index);
    return;
  }

  const winnerOptions = eligiblePlayers.map(({ index }) => `${index + 1}`).join('/');
  const input = window.prompt(`Who won? Enter ${winnerOptions}`, `${eligiblePlayers[0].index + 1}`);
  if (input === null) {
    return;
  }

  const winnerNumber = Number(input.trim());
  const winner = eligiblePlayers.find(({ index }) => index + 1 === winnerNumber);
  if (!winner) {
    window.alert('Enter a valid winner number.');
    return;
  }

  awardPotToWinner(winner.index);
}

function handlePlayerCardClick(index) {
  const player = state.players[index];
  if (!player || player.folded || !isBettingClosed()) {
    return;
  }

  awardPotToWinner(index);
}

function moveTurn() {
  if (state.handOver) {
    return;
  }

  if (canAdvanceStreet()) {
    return;
  }

  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const nextPlayer = (state.activePlayer + offset) % state.players.length;
    const player = state.players[nextPlayer];

    if (!player.folded && !isAllIn(player)) {
      state.activePlayer = nextPlayer;
      return;
    }
  }
}

function applyBet(amount) {
  const player = state.players[state.activePlayer];
  if (player.folded || state.handOver) {
    return;
  }

  const previousCurrentBet = getCurrentBet();
  const remaining = getRemaining(player);
  const betAmount = Math.min(amount, remaining);
  if (betAmount <= 0) {
    return;
  }

  const nextBet = player.streetBet + betAmount;
  const callAmount = Math.max(previousCurrentBet - player.streetBet, 0);
  const isRaise = nextBet > previousCurrentBet;
  const raiseSize = nextBet - previousCurrentBet;
  const isAllInMove = betAmount === remaining;

  if (isRaise) {
    const minimumRaiseTo = getMinimumRaiseTo(player);
    const isFullRaise = nextBet >= minimumRaiseTo;

    if (!isFullRaise && !isAllInMove) {
      window.alert(`Minimum raise is to ${formatNumber(minimumRaiseTo)}.`);
      return;
    }
  }

  player.streetBet = nextBet;
  player.handBet += betAmount;
  player.acted = true;
  clearPendingRaise();

  if (isRaise && raiseSize >= state.lastFullRaiseSize) {
    state.lastFullRaiseSize = raiseSize;
    state.players.forEach((item, index) => {
      item.acted = index === state.activePlayer;
    });
  } else if (callAmount > 0 && player.streetBet === previousCurrentBet) {
    player.acted = true;
  }

  moveTurn();
  render();
}

function addRaiseChip(chipIndex) {
  const player = state.players[state.activePlayer];
  if (player.folded || isBettingClosed()) {
    return;
  }

  const chip = chipOptions[chipIndex];
  if (!chip) {
    return;
  }

  const remaining = getRemaining(player);
  if (getPendingRaiseAmount(player) + chip.value > remaining) {
    return;
  }

  state.pendingRaiseChips = [...state.pendingRaiseChips, chip];
  render();
}

function clearRaiseSelection() {
  const player = state.players[state.activePlayer];
  if (!player || state.pendingRaiseChips.length === 0) {
    return;
  }

  clearPendingRaise();
  render();
}

function handleRaise() {
  const player = state.players[state.activePlayer];
  if (player.folded || isBettingClosed() || !canSubmitRaise(player)) {
    return;
  }

  applyBet(getPendingRaiseAmount(player));
}

function handleCall() {
  const player = state.players[state.activePlayer];
  if (player.folded || isBettingClosed()) {
    return;
  }

  const amountToCall = getNeedToCall(player);
  clearPendingRaise();

  if (amountToCall === 0) {
    player.acted = true;
    moveTurn();
    render();
    return;
  }

  applyBet(amountToCall);
}

function handleFold() {
  const player = state.players[state.activePlayer];
  if (player.folded || isBettingClosed()) {
    return;
  }

  player.folded = true;
  player.acted = true;
  clearPendingRaise();
  maybeEndHand();
  if (state.handOver) {
    promptForWinner();
    return;
  }

  moveTurn();
  render();
}

function nextStreet() {
  if (!canAdvanceStreet()) {
    return;
  }

  state.players.forEach((player) => {
    player.acted = false;
    player.streetBet = 0;
  });
  state.activePlayer = state.players.findIndex((player) => !player.folded && !isAllIn(player));
  if (state.activePlayer === -1) {
    state.activePlayer = 0;
  }
  state.lastFullRaiseSize = MIN_OPEN_BET;
  clearPendingRaise();
  render();
}

function resetHand() {
  startNextHand();
  render();
}

function resetGame() {
  const shouldReset = window.confirm('Reset the entire game and both stacks?');
  if (!shouldReset) {
    return;
  }

  state.players = state.players.map(() => createPlayer());
  startNextHand();
  render();
}

function render() {
  const app = document.querySelector('#app');
  const currentBet = getCurrentBet();
  const pot = getPot();
  const activePlayer = state.players[state.activePlayer];
  const pendingRaiseAmount = getPendingRaiseAmount(activePlayer);
  const pendingRaiseTo = getPendingRaiseTo(activePlayer);
  const bettingClosed = isBettingClosed();
  const raiseEnabled = canSubmitRaise(activePlayer);
  const callAmount = getNeedToCall(activePlayer);
  const raiseLabel = currentBet === 0 ? `Bet ${formatNumber(pendingRaiseAmount)}` : `Raise To ${formatNumber(pendingRaiseTo)}`;
  const callLabel = callAmount === 0 ? 'Check' : `Call ${formatNumber(callAmount)}`;
  const animatedPot = getAnimatedValue('pot', pot);
  const animatedCurrentBet = getAnimatedValue('currentBet', currentBet);

  app.innerHTML = `
    <main class="shell">
      <section class="topbar">
        <section class="summary-grid">
          <article class="summary-card">
            <span>Pot</span>
            <strong data-number-key="pot">${formatNumber(animatedPot)}</strong>
          </article>
          <article class="summary-card">
            <span>Bet</span>
            <strong data-number-key="currentBet">${formatNumber(animatedCurrentBet)}</strong>
          </article>
        </section>
        <div class="topbar-actions"></div>
      </section>

      <section class="panel panel-players">
        <div class="players">
          ${state.players
            .map((player, index) => {
              const isActive = index === state.activePlayer && !bettingClosed && !player.folded;
              const canPickWinner = bettingClosed && !player.folded;
              const animatedRemaining = getAnimatedValue(`player-${index}-remaining`, getRemaining(player));
              const animatedStreetBet = getAnimatedValue(`player-${index}-street`, player.streetBet);
              return `
                <article class="player-card ${isActive ? 'active' : ''} ${player.folded ? 'folded' : ''} ${bettingClosed ? 'showdown' : ''} ${canPickWinner ? 'pickable' : ''}" data-role="player-card" data-player-index="${index}">
                  <h2 class="player-title">${getPlayerLabel(index)}</h2>
                  <div class="stats">
                    <div class="stat-block stat-block-stack">
                      <span>Stack</span>
                      <strong data-number-key="player-${index}-remaining">${formatNumber(animatedRemaining)}</strong>
                    </div>
                    <div class="stat-block stat-block-street">
                      <span>Street</span>
                      <strong data-number-key="player-${index}-street">${formatNumber(animatedStreetBet)}</strong>
                    </div>
                  </div>
                </article>
              `;
            })
            .join('')}
        </div>
      </section>

      <section class="panel panel-actions">
        <div class="chip-row">
          ${chipOptions
            .map(
              (chip, index) => `
                <button class="chip-button" data-role="chip" data-chip-index="${index}" ${bettingClosed ? 'disabled' : ''}>
                  ${chip.label}
                </button>
              `,
            )
            .join('')}
        </div>
        <div class="action-row action-row-raise">
          <button class="action-button" data-role="clear-raise" ${state.pendingRaiseChips.length === 0 || bettingClosed ? 'disabled' : ''}>Clear</button>
          <button class="action-button primary" data-role="raise" ${raiseEnabled && !bettingClosed ? '' : 'disabled'}>${raiseLabel}</button>
        </div>
        <div class="action-row action-row-main">
          <button class="action-button primary" data-role="call" ${bettingClosed ? 'disabled' : ''}>${callLabel}</button>
          <button class="action-button danger" data-role="fold" ${bettingClosed ? 'disabled' : ''}>Fold</button>
        </div>
      </section>

      <section class="panel panel-footer-actions">
        <div class="footer-actions">
          <button class="secondary-button" id="next-street" ${canAdvanceStreet() ? '' : 'disabled'}>Tie</button>
          <button class="secondary-button" id="reset-hand">Reset</button>
        </div>
      </section>

      <footer class="game-footer">
        <button class="footer-reset-button" id="reset-game">Reset Game</button>
      </footer>
    </main>
  `;

  bindButtonSound('#reset-hand', resetHand);
  bindButtonSound('#reset-game', resetGame);
  bindButtonSound('#next-street', nextStreet);

  bindButtonSoundForAll('[data-role="player-card"]', (card) => {
    handlePlayerCardClick(Number(card.dataset.playerIndex));
  });

  bindButtonSoundForAll('[data-role="chip"]', (button) => {
    addRaiseChip(Number(button.dataset.chipIndex));
  });

  bindButtonSound('[data-role="clear-raise"]', clearRaiseSelection);
  bindButtonSound('[data-role="raise"]', handleRaise);
  bindButtonSound('[data-role="call"]', handleCall);
  bindButtonSound('[data-role="fold"]', handleFold);

  setAnimatedValue('pot', pot);
  setAnimatedValue('currentBet', currentBet);
  state.players.forEach((player, index) => {
    setAnimatedValue(`player-${index}-remaining`, getRemaining(player));
    setAnimatedValue(`player-${index}-street`, player.streetBet);
  });
  ensureAnimatedValuesRunning();
  syncMoneySound();
  queuePersistGameState();
}

function bindButtonSound(selector, handler) {
  const element = document.querySelector(selector);
  element.addEventListener('click', () => {
    playClickSound();
    handler();
  });
}

function bindButtonSoundForAll(selector, handler) {
  document.querySelectorAll(selector).forEach((element) => {
    element.addEventListener('click', () => {
      playClickSound();
      handler(element);
    });
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener('load', async () => {
    if (import.meta.env.DEV) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));

      if ('caches' in window) {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map((cacheKey) => caches.delete(cacheKey)));
      }
      return;
    }

    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // No-op: offline support is optional for local development.
    });
  });
}

async function initializeApp() {
  const persistedState = await loadPersistedState();
  const restored = hydrateState(persistedState);

  if (!restored) {
    startNextHand();
  }

  hasHydratedState = true;
  render();
  registerServiceWorker();
}

initializeApp();
