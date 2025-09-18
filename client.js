// Minimal client bootstrapping: canvas sizing, map loading, render tick.

const params = new URLSearchParams(window.location.search);
const serverUrl = params.get('server') || '';
const mapParam = params.get('map');
const avatarParam = params.get('avatar');
const speedParam = Number(params.get('speed'));

/** @type {HTMLCanvasElement} */
const canvas = document.getElementById('world-canvas');
/** @type {CanvasRenderingContext2D} */
const ctx = canvas.getContext('2d', { alpha: false });
ctx.imageSmoothingEnabled = false;

function getDevicePixelRatio() {
  const override = Number(params.get('dpr'));
  if (!Number.isNaN(override) && override > 0) return override;
  return Math.max(1, window.devicePixelRatio || 1);
}

function setCanvasSizeToViewport() {
  const cssWidth = window.innerWidth;
  const cssHeight = window.innerHeight;
  const dpr = getDevicePixelRatio();

  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';

  const targetWidth = Math.floor(cssWidth * dpr);
  const targetHeight = Math.floor(cssHeight * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
}

function clamp(value, min, max) {
  if (min > max) return min; // when map smaller than viewport
  return Math.max(min, Math.min(max, value));
}

// Global-ish state
const world = {
  image: null,
  width: 0,
  height: 0,
};

const selfPlayer = {
  id: null,
  name: 'Lynn',
  x: 0,
  y: 0,
  avatarImage: null,
  avatarWidth: 64,
  avatarHeight: 64,
};

const camera = { x: 0, y: 0 };

// Assets cache by URL
const imageCache = new Map();
const players = new Map(); // other players by id

function ensureOtherPlayer(id) {
  if (!players.has(id)) {
    players.set(id, {
      id,
      name: 'Player',
      x: 0,
      y: 0,
      avatarImage: null,
      avatarWidth: 48,
      avatarHeight: 48,
      labelCanvas: null,
      labelWidth: 0,
      labelHeight: 0,
    });
  }
  return players.get(id);
}

async function setPlayerAvatarFromDescriptor(player, avatarDesc) {
  if (avatarDesc?.url) {
    player.avatarImage = await loadImage(avatarDesc.url);
  }
  if (avatarDesc?.width && avatarDesc?.height) {
    player.avatarWidth = avatarDesc.width;
    player.avatarHeight = avatarDesc.height;
  } else if (player.avatarImage) {
    const w = player.avatarImage.naturalWidth || player.avatarImage.width;
    const h = player.avatarImage.naturalHeight || player.avatarImage.height;
    const maxSide = 48;
    if (w >= h) {
      player.avatarWidth = Math.min(maxSide, w);
      player.avatarHeight = Math.round((h / w) * player.avatarWidth);
    } else {
      player.avatarHeight = Math.min(maxSide, h);
      player.avatarWidth = Math.round((w / h) * player.avatarHeight);
    }
  }
}

function prepareLabelForPlayer(player) {
  const dpr = getDevicePixelRatio();
  const paddingX = Math.floor(6 * dpr);
  const paddingY = Math.floor(3 * dpr);
  const fontPx = Math.floor(12 * dpr);
  const temp = document.createElement('canvas');
  const tctx = temp.getContext('2d');
  tctx.font = `${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const metrics = tctx.measureText(player.name || 'Player');
  const textWidth = Math.ceil(metrics.width);
  const textHeight = Math.ceil(fontPx * 1.4);
  temp.width = textWidth + paddingX * 2;
  temp.height = textHeight + paddingY * 2;
  const tctx2 = temp.getContext('2d');
  tctx2.font = tctx.font;
  tctx2.textBaseline = 'top';
  tctx2.fillStyle = 'rgba(0,0,0,0.6)';
  tctx2.fillRect(0, 0, temp.width, temp.height);
  tctx2.fillStyle = '#fff';
  tctx2.fillText(player.name || 'Player', paddingX, paddingY);
  player.labelCanvas = temp;
  player.labelWidth = temp.width;
  player.labelHeight = temp.height;
}

async function upsertOtherPlayerFromServer(p) {
  const op = ensureOtherPlayer(p.playerId);
  if (typeof p.x === 'number') op.x = p.x;
  if (typeof p.y === 'number') op.y = p.y;
  if (typeof p.name === 'string') op.name = p.name;
  if (p.avatar) await setPlayerAvatarFromDescriptor(op, p.avatar);
  prepareLabelForPlayer(op);
}

// Input state
const pressedKeys = new Set();

function handleKeyDown(e) {
  const key = e.key;
  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
    e.preventDefault();
    pressedKeys.add(key);
    // Send one move command per keydown event (including repeats)
    const { dx, dy } = directionFromKey(key);
    sendMoveCommand(dx, dy);
  }
}

function handleKeyUp(e) {
  const key = e.key;
  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
    e.preventDefault();
    pressedKeys.delete(key);
  }
}

function directionFromKey(key) {
  switch (key) {
    case 'ArrowUp': return { dx: 0, dy: -1 };
    case 'ArrowDown': return { dx: 0, dy: 1 };
    case 'ArrowLeft': return { dx: -1, dy: 0 };
    case 'ArrowRight': return { dx: 1, dy: 0 };
    default: return { dx: 0, dy: 0 };
  }
}

async function loadImage(urlOrBlob) {
  if (urlOrBlob == null) return null;
  if (typeof urlOrBlob === 'string') {
    if (imageCache.has(urlOrBlob)) return imageCache.get(urlOrBlob);
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    const p = new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = reject;
    });
    img.src = urlOrBlob;
    const loaded = await p;
    imageCache.set(urlOrBlob, loaded);
    return loaded;
  } else if (urlOrBlob instanceof Blob) {
    const bitmap = await createImageBitmap(urlOrBlob);
    return bitmap; // drawImage supports ImageBitmap
  }
  return null;
}

async function loadMap() {
  const candidates = mapParam
    ? [mapParam]
    : [
        'assets/world.png',
        'assets/world-map.png',
        'assets/map.png',
        'world.png',
        'public/assets/world.png',
      ];
  for (const src of candidates) {
    try {
      const img = await loadImage(src);
      if (img) {
        world.image = img;
        world.width = img.naturalWidth || img.width;
        world.height = img.naturalHeight || img.height;
        return true;
      }
    } catch (_) {}
  }
  console.warn('No world map image found. Provide ?map=URL or place one at assets/world.png');
  return false;
}

// Networking: connect and join as Lynn
let socket = null;
function connectAndJoin() {
  return new Promise((resolve) => {
    if (!serverUrl) {
      // No server specified; skip connecting for local/offline preview
      resolve(false);
      return;
    }
    try {
      socket = new WebSocket(serverUrl);
    } catch (e) {
      console.warn('WebSocket unavailable or URL invalid:', e);
      resolve(false);
      return;
    }

    socket.binaryType = 'arraybuffer';
    let settled = false;
    socket.onopen = () => {
      const joinMsg = {
        type: 'join',
        name: selfPlayer.name,
      };
      socket.send(JSON.stringify(joinMsg));
    };

    socket.onmessage = async (ev) => {
      try {
        // Assuming JSON welcome for this milestone
        const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
        if (!msg) return;
        if (msg.type === 'welcome' || msg.type === 'join-ack') {
          selfPlayer.id = msg.playerId;
          selfPlayer.x = msg.spawn?.x ?? 0;
          selfPlayer.y = msg.spawn?.y ?? 0;

          // Avatar payload can be URL or data URL; size optional
          if (msg.avatar?.url) {
            selfPlayer.avatarImage = await loadImage(msg.avatar.url);
          }
          if (msg.avatar?.width && msg.avatar?.height) {
            selfPlayer.avatarWidth = msg.avatar.width;
            selfPlayer.avatarHeight = msg.avatar.height;
          } else if (selfPlayer.avatarImage) {
            const w = selfPlayer.avatarImage.naturalWidth || selfPlayer.avatarImage.width;
            const h = selfPlayer.avatarImage.naturalHeight || selfPlayer.avatarImage.height;
            // Default: scale to max 64 preserving aspect
            const maxSide = 64;
            if (w > 0 && h > 0) {
              if (w >= h) {
                selfPlayer.avatarWidth = Math.min(maxSide, w);
                selfPlayer.avatarHeight = Math.round((h / w) * selfPlayer.avatarWidth);
              } else {
                selfPlayer.avatarHeight = Math.min(maxSide, h);
                selfPlayer.avatarWidth = Math.round((w / h) * selfPlayer.avatarHeight);
              }
            }
          }

          // After we have self info, pre-render label and start loop
          prepareNameLabel();
          if (!settled) { settled = true; resolve(true); }

          // Optional initial roster of other players
          if (Array.isArray(msg.players)) {
            for (const p of msg.players) {
              if (!p || p.playerId === selfPlayer.id) continue;
              await upsertOtherPlayerFromServer(p);
            }
          }
        } else if (msg.type === 'players' || msg.type === 'state') {
          // Snapshot of players
          if (Array.isArray(msg.players)) {
            // Rebuild map but keep self out
            const seen = new Set();
            for (const p of msg.players) {
              if (!p || p.playerId === selfPlayer.id) continue;
              await upsertOtherPlayerFromServer(p);
              seen.add(p.playerId);
            }
            // Remove any not present
            for (const id of players.keys()) {
              if (!seen.has(id)) players.delete(id);
            }
          }
        } else if (msg.type === 'player-joined') {
          if (msg.player && msg.player.playerId !== selfPlayer.id) {
            await upsertOtherPlayerFromServer(msg.player);
          }
        } else if (msg.type === 'player-left') {
          if (msg.playerId) players.delete(msg.playerId);
        } else if (msg.type === 'player-update' || msg.type === 'move' || msg.type === 'position') {
          const id = msg.playerId;
          if (id && id !== selfPlayer.id) {
            const op = ensureOtherPlayer(id);
            if (typeof msg.x === 'number') op.x = msg.x;
            if (typeof msg.y === 'number') op.y = msg.y;
            if (msg.avatar && msg.avatar.url) {
              await setPlayerAvatarFromDescriptor(op, msg.avatar);
            }
            if (typeof msg.name === 'string' && msg.name !== op.name) {
              op.name = msg.name;
              prepareLabelForPlayer(op);
            }
          }
        }
      } catch (e) {
        console.warn('Message handling error:', e);
      }
    };

    socket.onerror = () => { if (!settled) { settled = true; console.warn('WebSocket connection failed. Provide ?server=ws://host:port to override.'); resolve(false); } };
    socket.onclose = () => { if (!settled) { settled = true; resolve(false); } };
  });
}

function sendMoveCommand(dx, dy) {
  if (!socket || socket.readyState !== 1 /* OPEN */) return;
  try {
    const msg = { type: 'move', dx, dy, at: Date.now() };
    socket.send(JSON.stringify(msg));
  } catch (_) {}
}

// Pre-rendered label for efficiency
let labelCanvas = null;
let labelWidth = 0;
let labelHeight = 0;
function prepareNameLabel() {
  const dpr = getDevicePixelRatio();
  const paddingX = Math.floor(6 * dpr);
  const paddingY = Math.floor(3 * dpr);
  const fontPx = Math.floor(12 * dpr);

  const temp = document.createElement('canvas');
  const tctx = temp.getContext('2d');
  tctx.font = `${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const metrics = tctx.measureText(selfPlayer.name);
  const textWidth = Math.ceil(metrics.width);
  const textHeight = Math.ceil(fontPx * 1.4);
  temp.width = textWidth + paddingX * 2;
  temp.height = textHeight + paddingY * 2;
  const tctx2 = temp.getContext('2d');
  tctx2.font = tctx.font;
  tctx2.textBaseline = 'top';
  tctx2.fillStyle = 'rgba(0,0,0,0.6)';
  tctx2.fillRect(0, 0, temp.width, temp.height);
  tctx2.fillStyle = '#fff';
  tctx2.fillText(selfPlayer.name, paddingX, paddingY);

  labelCanvas = temp;
  labelWidth = temp.width;
  labelHeight = temp.height;
}

function updateCamera() {
  const dpr = getDevicePixelRatio();
  const viewW = Math.floor(window.innerWidth * dpr);
  const viewH = Math.floor(window.innerHeight * dpr);

  let desiredX = Math.floor(selfPlayer.x - viewW / 2);
  let desiredY = Math.floor(selfPlayer.y - viewH / 2);

  const maxX = Math.max(0, world.width - viewW);
  const maxY = Math.max(0, world.height - viewH);

  camera.x = clamp(desiredX, 0, maxX);
  camera.y = clamp(desiredY, 0, maxY);
}

let lastTs = performance.now();
const moveSpeed = Number.isFinite(speedParam) && speedParam > 0 ? speedParam : 200; // world px/sec

function integrateMovement() {
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0, (now - lastTs) / 1000)); // clamp dt to 50ms
  lastTs = now;

  // Build direction from pressed keys
  let dx = 0;
  let dy = 0;
  if (pressedKeys.has('ArrowLeft')) dx -= 1;
  if (pressedKeys.has('ArrowRight')) dx += 1;
  if (pressedKeys.has('ArrowUp')) dy -= 1;
  if (pressedKeys.has('ArrowDown')) dy += 1;

  if (dx === 0 && dy === 0) return;

  // Normalize diagonal speed
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;

  const dist = moveSpeed * dt;
  selfPlayer.x += dx * dist;
  selfPlayer.y += dy * dist;

  // Clamp to world bounds
  const maxX = Math.max(0, world.width);
  const maxY = Math.max(0, world.height);
  selfPlayer.x = clamp(selfPlayer.x, 0, maxX);
  selfPlayer.y = clamp(selfPlayer.y, 0, maxY);
}

function draw() {
  setCanvasSizeToViewport();
  updateCamera();

  const dpr = getDevicePixelRatio();
  const viewW = canvas.width; // already in device pixels
  const viewH = canvas.height;

  // Continuous local movement
  integrateMovement();

  // Draw world map subsection aligned to camera
  if (world.image) {
    const sx = camera.x;
    const sy = camera.y;
    const sw = Math.min(viewW, world.width - sx);
    const sh = Math.min(viewH, world.height - sy);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(world.image, sx, sy, sw, sh, 0, 0, sw, sh);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Convert self world position to screen
  const screenX = Math.round(selfPlayer.x - camera.x);
  const screenY = Math.round(selfPlayer.y - camera.y);

  // Draw avatar centered on self position
  if (selfPlayer.avatarImage) {
    // Avatar size is in world pixels; no DPR multiplier here
    const aw = Math.floor(selfPlayer.avatarWidth);
    const ah = Math.floor(selfPlayer.avatarHeight);
    ctx.drawImage(
      selfPlayer.avatarImage,
      Math.round(screenX - aw / 2),
      Math.round(screenY - ah / 2),
      aw,
      ah
    );
  }

  // Draw name label centered above avatar
  if (labelCanvas) {
    const offsetY = Math.floor(selfPlayer.avatarHeight / 2) + Math.floor(8 * dpr);
    const dx = Math.round(screenX - labelWidth / 2);
    const dy = Math.round(screenY - offsetY - labelHeight);
    ctx.drawImage(labelCanvas, dx, dy);
  }

  // Render other players with simple culling
  if (players.size > 0) {
    for (const op of players.values()) {
      const sx = Math.round(op.x - camera.x);
      const sy = Math.round(op.y - camera.y);
      // cull if completely off-screen
      const halfW = Math.floor(op.avatarWidth / 2);
      const halfH = Math.floor(op.avatarHeight / 2);
      if (sx + halfW < 0 || sy + halfH < 0 || sx - halfW > viewW || sy - halfH > viewH) {
        continue;
      }

      if (op.avatarImage) {
        ctx.drawImage(op.avatarImage, Math.round(sx - halfW), Math.round(sy - halfH), op.avatarWidth, op.avatarHeight);
      }
      if (op.labelCanvas) {
        const dpr = getDevicePixelRatio();
        const offsetY = Math.floor(op.avatarHeight / 2) + Math.floor(8 * dpr);
        const dx = Math.round(sx - op.labelWidth / 2);
        const dy = Math.round(sy - offsetY - op.labelHeight);
        ctx.drawImage(op.labelCanvas, dx, dy);
      }
    }
  }
}

function loop() {
  draw();
  requestAnimationFrame(loop);
}

(async function init() {
  setCanvasSizeToViewport();
  await loadMap();

  // Connect to server and join as Lynn; if fails, still render with default avatar placeholder
  const joined = await connectAndJoin();
  if (!joined) {
    // Fallback: place Lynn at map center
    if (world.width > 0 && world.height > 0) {
      selfPlayer.x = Math.floor(world.width / 2);
      selfPlayer.y = Math.floor(world.height / 2);
    }
  }

  // Ensure we have some avatar even if server didn't provide one
  if (!selfPlayer.avatarImage) {
    try {
      if (avatarParam) {
        selfPlayer.avatarImage = await loadImage(avatarParam);
        // Infer default size preserving aspect, max 64px if not specified by server
        const w = selfPlayer.avatarImage.naturalWidth || selfPlayer.avatarImage.width || 64;
        const h = selfPlayer.avatarImage.naturalHeight || selfPlayer.avatarImage.height || 64;
        const maxSide = 64;
        if (w >= h) {
          selfPlayer.avatarWidth = Math.min(maxSide, w);
          selfPlayer.avatarHeight = Math.round((h / w) * selfPlayer.avatarWidth);
        } else {
          selfPlayer.avatarHeight = Math.min(maxSide, h);
          selfPlayer.avatarWidth = Math.round((w / h) * selfPlayer.avatarHeight);
        }
      } else {
        // Build a simple placeholder avatar
        const size = 64;
        const off = document.createElement('canvas');
        off.width = size;
        off.height = size;
        const octx = off.getContext('2d');
        octx.fillStyle = '#2d6cdf';
        octx.beginPath();
        octx.arc(size/2, size/2, size/2, 0, Math.PI * 2);
        octx.fill();
        octx.fillStyle = '#fff';
        octx.font = 'bold 32px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        octx.textAlign = 'center';
        octx.textBaseline = 'middle';
        octx.fillText(selfPlayer.name.slice(0,1).toUpperCase(), size/2, size/2 + 1);
        selfPlayer.avatarImage = off;
        selfPlayer.avatarWidth = size;
        selfPlayer.avatarHeight = size;
      }
    } catch (e) {
      console.warn('Failed to load avatar from ?avatar=, using placeholder.', e);
    }
  }

  // Prepare label (depends on DPR); also refresh on resize for crispness
  prepareNameLabel();

  window.addEventListener('resize', setCanvasSizeToViewport);
  window.addEventListener('orientationchange', setCanvasSizeToViewport);
  window.addEventListener('resize', () => prepareNameLabel());
  window.addEventListener('orientationchange', () => prepareNameLabel());
  window.addEventListener('keydown', handleKeyDown, { passive: false });
  window.addEventListener('keyup', handleKeyUp, { passive: false });
  window.addEventListener('blur', () => pressedKeys.clear());
  // Refresh labels for other players on DPR change
  window.addEventListener('resize', () => { for (const op of players.values()) prepareLabelForPlayer(op); });
  window.addEventListener('orientationchange', () => { for (const op of players.values()) prepareLabelForPlayer(op); });

  loop();
})();

