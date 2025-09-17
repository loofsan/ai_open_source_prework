// Minimal client bootstrapping: canvas sizing, map loading, render tick.

const params = new URLSearchParams(window.location.search);
const serverUrl = params.get("server") || "ws://localhost:8080";
const mapParam = params.get("map");

/** @type {HTMLCanvasElement} */
const canvas = document.getElementById("world-canvas");
/** @type {CanvasRenderingContext2D} */
const ctx = canvas.getContext("2d", { alpha: false });
ctx.imageSmoothingEnabled = false;

function getDevicePixelRatio() {
  const override = Number(params.get("dpr"));
  if (!Number.isNaN(override) && override > 0) return override;
  return Math.max(1, window.devicePixelRatio || 1);
}

function setCanvasSizeToViewport() {
  const cssWidth = window.innerWidth;
  const cssHeight = window.innerHeight;
  const dpr = getDevicePixelRatio();

  canvas.style.width = cssWidth + "px";
  canvas.style.height = cssHeight + "px";

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
  name: "Lynn",
  x: 0,
  y: 0,
  avatarImage: null,
  avatarWidth: 64,
  avatarHeight: 64,
};

const camera = { x: 0, y: 0 };

// Assets cache by URL
const imageCache = new Map();

async function loadImage(urlOrBlob) {
  if (urlOrBlob == null) return null;
  if (typeof urlOrBlob === "string") {
    if (imageCache.has(urlOrBlob)) return imageCache.get(urlOrBlob);
    const img = new Image();
    img.decoding = "async";
    img.crossOrigin = "anonymous";
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
        "assets/world.jpg",
        "assets/world-map.jpg",
        "assets/map.jpg",
        "world.jpg",
        "public/assets/world.jpg",
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
  console.warn(
    "No world map image found. Provide ?map=URL or place one at assets/world.png"
  );
  return false;
}

// Networking: connect and join as Lynn
let socket = null;
function connectAndJoin() {
  return new Promise((resolve) => {
    try {
      socket = new WebSocket(serverUrl);
    } catch (e) {
      console.warn("WebSocket unavailable or URL invalid:", e);
      resolve(false);
      return;
    }

    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      const joinMsg = {
        type: "join",
        name: selfPlayer.name,
      };
      socket.send(JSON.stringify(joinMsg));
    };

    socket.onmessage = async (ev) => {
      try {
        // Assuming JSON welcome for this milestone
        const msg = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
        if (!msg) return;
        if (msg.type === "welcome" || msg.type === "join-ack") {
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
            const w =
              selfPlayer.avatarImage.naturalWidth ||
              selfPlayer.avatarImage.width;
            const h =
              selfPlayer.avatarImage.naturalHeight ||
              selfPlayer.avatarImage.height;
            // Default: scale to max 64 preserving aspect
            const maxSide = 64;
            if (w > 0 && h > 0) {
              if (w >= h) {
                selfPlayer.avatarWidth = Math.min(maxSide, w);
                selfPlayer.avatarHeight = Math.round(
                  (h / w) * selfPlayer.avatarWidth
                );
              } else {
                selfPlayer.avatarHeight = Math.min(maxSide, h);
                selfPlayer.avatarWidth = Math.round(
                  (w / h) * selfPlayer.avatarHeight
                );
              }
            }
          }

          // After we have self info, pre-render label and start loop
          prepareNameLabel();
          resolve(true);
        }
      } catch (e) {
        console.warn("Message handling error:", e);
      }
    };

    socket.onerror = () => resolve(false);
    socket.onclose = () => {};
  });
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

  const temp = document.createElement("canvas");
  const tctx = temp.getContext("2d");
  tctx.font = `${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const metrics = tctx.measureText(selfPlayer.name);
  const textWidth = Math.ceil(metrics.width);
  const textHeight = Math.ceil(fontPx * 1.4);
  temp.width = textWidth + paddingX * 2;
  temp.height = textHeight + paddingY * 2;
  const tctx2 = temp.getContext("2d");
  tctx2.font = tctx.font;
  tctx2.textBaseline = "top";
  tctx2.fillStyle = "rgba(0,0,0,0.6)";
  tctx2.fillRect(0, 0, temp.width, temp.height);
  tctx2.fillStyle = "#fff";
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

function draw() {
  setCanvasSizeToViewport();
  updateCamera();

  const dpr = getDevicePixelRatio();
  const viewW = canvas.width; // already in device pixels
  const viewH = canvas.height;

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
    const aw = Math.floor(selfPlayer.avatarWidth * dpr);
    const ah = Math.floor(selfPlayer.avatarHeight * dpr);
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
    const offsetY =
      Math.floor((selfPlayer.avatarHeight * dpr) / 2) + Math.floor(8 * dpr);
    const dx = Math.round(screenX - labelWidth / 2);
    const dy = Math.round(screenY - offsetY - labelHeight);
    ctx.drawImage(labelCanvas, dx, dy);
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
    prepareNameLabel();
  }

  window.addEventListener("resize", setCanvasSizeToViewport);
  window.addEventListener("orientationchange", setCanvasSizeToViewport);

  loop();
})();
