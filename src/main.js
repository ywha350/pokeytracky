import './style.css';

const DEFAULT_ENTRY_FEE = 1;
const DEFAULT_STARTING_STACK = 200;
const DEFAULT_PLAYER_COUNT = 2;
const MIN_PLAYER_COUNT = 2;
const MAX_PLAYER_COUNT = 4;
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
const PICKUP_COIN_SOUND_URL = `${import.meta.env.BASE_URL}pickupCoin%20(1).wav`;
let gameDbPromise = null;
let persistWritePromise = Promise.resolve();
let persistQueued = false;
let hasHydratedState = false;
let audioContext = null;
let audioUnlocked = false;
let lastMoneySignature = null;
let pendingMoneySound = null;

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

function playPickupCoinSound() {
  const sound = new Audio(PICKUP_COIN_SOUND_URL);
  sound.volume = 0.72;
  sound.play().catch(() => {});
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
    if (pendingMoneySound === 'pickup') {
      playPickupCoinSound();
    } else {
      playMoneySound();
    }
    pendingMoneySound = null;
    lastMoneySignature = signature;
  }
}

function queueMoneySound(type) {
  pendingMoneySound = type;
}

function createPlayer() {
  return {
    stack: state.settings.startingStack,
    handBet: 0,
    streetBet: 0,
    folded: false,
    acted: false,
    settled: false,
    paid: false,
  };
}

function normalizePlayer(player = {}) {
  return {
    stack: Number.isFinite(player.stack) ? player.stack : state.settings.startingStack,
    handBet: Number.isFinite(player.handBet) ? player.handBet : 0,
    streetBet: Number.isFinite(player.streetBet) ? player.streetBet : 0,
    folded: Boolean(player.folded),
    acted: Boolean(player.acted),
    settled: Boolean(player.settled),
    paid: Boolean(player.paid),
  };
}

function getChipOptionByValue(value) {
  return chipOptions.find((chip) => chip.value === value) ?? null;
}

function serializeState() {
  return {
    settings: { ...state.settings },
    players: state.players.map((player) => ({ ...player })),
    activePlayer: state.activePlayer,
    priorityPlayer: state.priorityPlayer,
    handOver: state.handOver,
    settlingPot: state.settlingPot,
    lastFullRaiseSize: state.lastFullRaiseSize,
    pendingRaiseChipValues: state.pendingRaiseChips.map((chip) => chip.value),
  };
}

function hydrateState(snapshot) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.players) ||
    snapshot.players.length < MIN_PLAYER_COUNT ||
    snapshot.players.length > MAX_PLAYER_COUNT
  ) {
    return false;
  }

  state.settings = normalizeSettings({
    ...snapshot.settings,
    playerCount: snapshot.players.length,
  });

  state.players = snapshot.players.map((player) => normalizePlayer(player));
  state.activePlayer = Number.isInteger(snapshot.activePlayer) ? snapshot.activePlayer : 0;
  if (state.activePlayer < 0 || state.activePlayer >= state.players.length) {
    state.activePlayer = 0;
  }
  state.priorityPlayer = Number.isInteger(snapshot.priorityPlayer) ? snapshot.priorityPlayer : state.activePlayer;
  if (state.priorityPlayer < 0 || state.priorityPlayer >= state.players.length) {
    state.priorityPlayer = state.activePlayer;
  }
  state.handOver = Boolean(snapshot.handOver);
  state.settlingPot = Boolean(snapshot.settlingPot);
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

function normalizeSettings(settings = {}) {
  const startingStack = Number.isFinite(settings.startingStack) ? Math.max(1, Math.floor(settings.startingStack)) : DEFAULT_STARTING_STACK;
  const entryFee = Number.isFinite(settings.entryFee) ? Math.max(0, Math.floor(settings.entryFee)) : DEFAULT_ENTRY_FEE;
  const playerCount = Number.isFinite(settings.playerCount)
    ? Math.min(MAX_PLAYER_COUNT, Math.max(MIN_PLAYER_COUNT, Math.floor(settings.playerCount)))
    : DEFAULT_PLAYER_COUNT;

  return {
    startingStack,
    entryFee: Math.min(entryFee, startingStack),
    playerCount,
  };
}

const state = {
  settings: normalizeSettings(),
  players: Array.from({ length: DEFAULT_PLAYER_COUNT }, () => ({
    stack: DEFAULT_STARTING_STACK,
    handBet: 0,
    streetBet: 0,
    folded: false,
    acted: false,
    settled: false,
    paid: false,
  })),
  activePlayer: 0,
  priorityPlayer: -1,
  handOver: false,
  settlingPot: false,
  lastFullRaiseSize: 10,
  pendingRaiseChips: [],
};

function getRemaining(player) {
  return Math.max(player.stack - player.handBet, 0);
}

function isPlayerEligible(player) {
  return !player.folded && !player.settled;
}

function findPlayerFrom(startIndex, predicate) {
  for (let offset = 0; offset < state.players.length; offset += 1) {
    const index = (startIndex + offset + state.players.length) % state.players.length;
    if (predicate(state.players[index])) {
      return index;
    }
  }

  return -1;
}

function getCurrentBet() {
  return Math.max(0, ...state.players.filter((player) => isPlayerEligible(player)).map((player) => player.streetBet));
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

function isAllIn(player) {
  return getRemaining(player) === 0;
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
    const shouldShowDirection = key.startsWith('player-');

    element.textContent = formatNumber(entry.value);
    element.classList.toggle('value-animating', entry.animating);
    element.classList.toggle('value-increasing', shouldShowDirection && entry.animating && entry.direction > 0);
    element.classList.toggle('value-decreasing', shouldShowDirection && entry.animating && entry.direction < 0);
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

function isShortAllInRaise(player) {
  const remaining = getRemaining(player);
  const callAmount = getNeedToCall(player);

  return !player.acted && remaining > callAmount && remaining < getMinimumRaiseAmount(player);
}

function getRaiseActionAmount(player) {
  if (isShortAllInRaise(player)) {
    return getRemaining(player);
  }

  return getPendingRaiseAmount(player);
}

function canSubmitRaise(player) {
  if (!isPlayerEligible(player) || player.acted) {
    return false;
  }

  const raiseAmount = getRaiseActionAmount(player);
  return raiseAmount > getNeedToCall(player) && raiseAmount <= getRemaining(player);
}

function canAddRaiseChips(player) {
  return canSubmitRaise(player) && !isShortAllInRaise(player);
}

function canAdvanceStreet() {
  if (state.handOver || state.settlingPot) {
    return false;
  }

  const activePlayers = state.players.filter((player) => isPlayerEligible(player));
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
  return state.handOver || state.settlingPot || canAdvanceStreet();
}

function getPostedAnte(player) {
  return Math.min(player.stack, state.settings.entryFee);
}

function maybeEndHand() {
  const playersInHand = state.players.filter((player) => isPlayerEligible(player));
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
    player.settled = false;
    player.paid = false;
  });
  const nextPriority = (state.priorityPlayer + 1 + state.players.length) % state.players.length;
  const firstActionablePlayer = findPlayerFrom(nextPriority, (player) => !isAllIn(player));
  state.priorityPlayer = firstActionablePlayer === -1 ? nextPriority : firstActionablePlayer;
  state.activePlayer = state.priorityPlayer;
  state.handOver = false;
  state.settlingPot = false;
  state.lastFullRaiseSize = MIN_OPEN_BET;
  clearPendingRaise();
}

function preparePotSettlement() {
  state.settlingPot = true;
  state.players.forEach((player) => {
    player.streetBet = 0;
  });
  state.lastFullRaiseSize = MIN_OPEN_BET;
  clearPendingRaise();
}

function collectContributionsUpTo(maximumContribution) {
  let collected = 0;

  state.players.forEach((player) => {
    const contribution = Math.min(player.handBet, maximumContribution);
    player.stack -= contribution;
    player.handBet -= contribution;
    collected += contribution;
  });

  return collected;
}

function settleUncontestedPot() {
  const eligiblePlayers = state.players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => isPlayerEligible(player) && player.handBet > 0);

  if (eligiblePlayers.length > 1) {
    return false;
  }

  if (eligiblePlayers.length === 1) {
    const winner = eligiblePlayers[0].player;
    let award = 0;

    state.players.forEach((player) => {
      player.stack -= player.handBet;
      award += player.handBet;
      player.handBet = 0;
    });

    winner.stack += award;
    winner.settled = true;
    winner.paid = true;
    return true;
  }

  state.players.forEach((player) => {
    player.handBet = 0;
  });
  return true;
}

function awardPotToWinner(winnerIndex) {
  const winner = state.players[winnerIndex];
  if (!winner || !isPlayerEligible(winner) || winner.handBet <= 0) {
    return;
  }

  preparePotSettlement();
  const winnerContribution = winner.handBet;
  const award = collectContributionsUpTo(winnerContribution);
  winner.stack += award;
  winner.settled = true;
  winner.paid = true;

  state.players.forEach((player) => {
    if (isPlayerEligible(player) && player.handBet === 0) {
      player.settled = true;
    }
  });

  settleUncontestedPot();
  playWinnerSound();

  if (getPot() === 0) {
    startNextHand();
  }

  render();
}

function promptForWinner() {
  const eligiblePlayers = state.players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => isPlayerEligible(player));

  if (eligiblePlayers.length === 0) {
    return;
  }

  if (getPot() === 0) {
    startNextHand();
    render();
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
  if (!player || !isPlayerEligible(player) || player.handBet <= 0 || !isBettingClosed()) {
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

    if (isPlayerEligible(player) && !isAllIn(player)) {
      state.activePlayer = nextPlayer;
      return;
    }
  }
}

function applyBet(amount) {
  const player = state.players[state.activePlayer];
  if (!isPlayerEligible(player) || state.handOver || state.settlingPot) {
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
      if (isPlayerEligible(item)) {
        item.acted = index === state.activePlayer;
      }
    });
  } else if (callAmount > 0 && player.streetBet === previousCurrentBet) {
    player.acted = true;
  }

  moveTurn();
  render();
}

function addRaiseChip(chipIndex) {
  const player = state.players[state.activePlayer];
  if (!isPlayerEligible(player) || isBettingClosed() || !canAddRaiseChips(player)) {
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
  if (!isPlayerEligible(player) || isBettingClosed() || !canSubmitRaise(player)) {
    return;
  }

  queueMoneySound('pickup');
  applyBet(getRaiseActionAmount(player));
}

function handleCall() {
  const player = state.players[state.activePlayer];
  if (!isPlayerEligible(player) || isBettingClosed()) {
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

  queueMoneySound('pickup');
  applyBet(amountToCall);
}

function handleFold() {
  const player = state.players[state.activePlayer];
  if (!isPlayerEligible(player) || isBettingClosed()) {
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
  if (!state.settlingPot && !canAdvanceStreet()) {
    return;
  }

  state.settlingPot = false;
  state.players.forEach((player) => {
    player.acted = false;
    player.streetBet = 0;
  });

  let firstActionablePlayer = findPlayerFrom(
    state.priorityPlayer,
    (player) => isPlayerEligible(player) && !isAllIn(player),
  );
  if (firstActionablePlayer === -1) {
    firstActionablePlayer = findPlayerFrom(state.priorityPlayer, (player) => isPlayerEligible(player));
  }
  if (firstActionablePlayer !== -1) {
    state.priorityPlayer = firstActionablePlayer;
    state.activePlayer = firstActionablePlayer;
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
  const shouldReset = window.confirm('Reset the entire game and all player stacks?');
  if (!shouldReset) {
    return;
  }

  state.players = state.players.map(() => createPlayer());
  state.priorityPlayer = -1;
  startNextHand();
  render();
}

function promptForPositiveWholeNumber(message, initialValue, minimum = 0, maximum = Infinity) {
  const input = window.prompt(message, `${initialValue}`);
  if (input === null) {
    return null;
  }

  const value = Number(input.trim());
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    const rangeMessage = Number.isFinite(maximum)
      ? `between ${minimum} and ${maximum}`
      : `of at least ${minimum}`;
    window.alert(`Enter a whole number ${rangeMessage}.`);
    return null;
  }

  return value;
}

function openSettings() {
  const nextPlayerCount = promptForPositiveWholeNumber(
    'Number of players (2-4)',
    state.settings.playerCount,
    MIN_PLAYER_COUNT,
    MAX_PLAYER_COUNT,
  );
  if (nextPlayerCount === null) {
    return;
  }

  const nextStartingStack = promptForPositiveWholeNumber('Starting stack per player', state.settings.startingStack, 1);
  if (nextStartingStack === null) {
    return;
  }

  const nextEntryFee = promptForPositiveWholeNumber('Entry fee (ante) per hand', state.settings.entryFee, 0);
  if (nextEntryFee === null) {
    return;
  }

  if (nextEntryFee > nextStartingStack) {
    window.alert('Entry fee cannot be greater than the starting stack.');
    return;
  }

  state.settings = normalizeSettings({
    startingStack: nextStartingStack,
    entryFee: nextEntryFee,
    playerCount: nextPlayerCount,
  });
  state.players = Array.from({ length: state.settings.playerCount }, () => createPlayer());
  state.priorityPlayer = -1;
  startNextHand();
  render();
}

function render() {
  const app = document.querySelector('#app');
  const currentBet = getCurrentBet();
  const pot = getPot();
  const activePlayer = state.players[state.activePlayer];
  const shortAllInRaise = isShortAllInRaise(activePlayer);
  const raiseActionAmount = getRaiseActionAmount(activePlayer);
  const raiseActionTo = activePlayer.streetBet + raiseActionAmount;
  const bettingClosed = isBettingClosed();
  const raiseEnabled = canSubmitRaise(activePlayer);
  const raiseChipsEnabled = canAddRaiseChips(activePlayer) && !bettingClosed;
  const callAmount = getNeedToCall(activePlayer);
  const callPayment = Math.min(callAmount, getRemaining(activePlayer));
  const raiseLabel = shortAllInRaise
    ? `All-in ${formatNumber(raiseActionAmount)}`
    : currentBet === 0
      ? `Bet ${formatNumber(raiseActionAmount)}`
      : `Raise To ${formatNumber(raiseActionTo)}`;
  const callLabel =
    callAmount === 0
      ? 'Check'
      : callPayment < callAmount
        ? `All-in ${formatNumber(callPayment)}`
        : `Call ${formatNumber(callAmount)}`;
  const tieEnabled = state.settlingPot || canAdvanceStreet();
  const winnerSelection = bettingClosed && pot > 0;
  const winnerMessage = state.settlingPot ? 'Next Winner' : 'Pick Winner';
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

      <section class="panel panel-players ${state.players.length >= 3 ? 'panel-players-fixed' : ''}">
        ${
          state.players.length >= 3
            ? `
              <div class="player-panel-sizer" aria-hidden="true">
                <article class="player-card">
                  <h2 class="player-title">Player</h2>
                  <div class="stats">
                    <div class="stat-block stat-block-stack">
                      <span>Stack</span>
                      <strong>${formatNumber(state.settings.startingStack)}</strong>
                    </div>
                    <div class="stat-block stat-block-street">
                      <span>Street</span>
                      <strong>0</strong>
                    </div>
                  </div>
                </article>
              </div>
            `
            : ''
        }
        <div class="players players-${state.players.length}">
          ${state.players
            .map((player, index) => {
              const isActive = index === state.activePlayer && !bettingClosed && isPlayerEligible(player);
              const canPickWinner = bettingClosed && isPlayerEligible(player) && player.handBet > 0;
              const animatedRemaining = getAnimatedValue(`player-${index}-remaining`, getRemaining(player));
              const animatedStreetBet = getAnimatedValue(`player-${index}-street`, player.streetBet);
              return `
                <article class="player-card player-${index + 1} ${isActive ? 'active' : ''} ${player.folded ? 'folded' : ''} ${player.settled ? 'settled' : ''} ${bettingClosed ? 'showdown' : ''} ${canPickWinner ? 'pickable' : ''}" data-role="player-card" data-player-index="${index}">
                  <h2 class="player-title">
                    <span class="player-name">
                      ${index === state.priorityPlayer ? '<span class="priority-star" aria-label="Priority" title="Priority">★</span>' : ''}
                      <span>${getPlayerLabel(index)}</span>
                    </span>
                    ${player.settled ? `<small>${player.paid ? 'Paid' : 'Out'}</small>` : ''}
                  </h2>
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

      <section class="panel panel-actions ${winnerSelection ? 'winner-selection' : ''}">
        <div class="action-controls" ${winnerSelection ? 'aria-hidden="true"' : ''}>
          <div class="chip-row">
            ${chipOptions
              .map(
                (chip, index) => `
                  <button class="chip-button" data-role="chip" data-chip-index="${index}" ${raiseChipsEnabled ? '' : 'disabled'}>
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
        </div>
        ${winnerSelection ? `<div class="winner-message">${winnerMessage}</div>` : ''}
      </section>

      <section class="panel panel-footer-actions">
        <div class="footer-actions">
          <button class="secondary-button" id="next-street" ${tieEnabled ? '' : 'disabled'}>Tie</button>
          <button class="secondary-button" id="reset-hand">Reset</button>
        </div>
      </section>

      <footer class="game-footer">
        <button class="footer-reset-button" id="open-settings">Settings</button>
        <button class="footer-reset-button" id="reset-game">Reset Game</button>
      </footer>
    </main>
  `;

  bindButtonSound('#open-settings', openSettings);
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
