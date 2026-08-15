/*
 * 网页端不把 QR slug、媒体 Blob 或 capability 写入 localStorage / IndexedDB。
 * 页面刷新会丢弃未发送内容，优先避免共享设备遗留宾客隐私。
 */
const api = "https://event-voice-booth-web-guest.event-voice-booth-web-guest.workers.dev";
const slug = location.pathname.split("/").filter(Boolean).at(-1);
const $ = (id) => document.getElementById(id);
const state = { config: null, recorder: null, stream: null, chunks: [], audio: null, photos: [], photosPreparing: false, submissionID: null, pollTimer: null };
const status = (message) => { $("status").textContent = message; };
const updateSendSummary = () => { $("send-summary").textContent = state.photosPreparing ? "Preparing photos securely…" : `This message will be sent with ${state.photos.length} photo${state.photos.length === 1 ? "" : "s"}.`; };
const setPhotoControls = (disabled) => { $("take-photo").disabled = disabled; $("choose-photos").disabled = disabled; };
const withTimeout = (promise, milliseconds, message) => Promise.race([promise, new Promise((_, reject) => window.setTimeout(() => reject(new Error(message)), milliseconds))]);

// Face Landmarker 和 WASM 都以静态文件随 Pages 一起发布；不从 CDN 加载，也不向
// 第三方发送照片、视频帧或 landmarks。仅在用户选择非 Natural 效果并拍照后惰性加载。
let faceLandmarkerPromise;
async function faceLandmarker() {
  if (!faceLandmarkerPromise) {
    faceLandmarkerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import("/vendor/mediapipe/vision_bundle.mjs");
      const vision = await FilesetResolver.forVisionTasks("/vendor/mediapipe");
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: "/vendor/mediapipe/face_landmarker.task" },
        runningMode: "IMAGE",
        numFaces: 1
      });
    })();
  }
  return faceLandmarkerPromise;
}

function point(landmarks, index, width, height) { const value = landmarks[index]; return value && { x: value.x * width, y: value.y * height }; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function drawEllipse(context, center, width, height, rotation, fill, stroke) { context.save(); context.translate(center.x, center.y); context.rotate(rotation); context.beginPath(); context.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2); context.fillStyle = fill; context.fill(); if (stroke) { context.strokeStyle = stroke; context.lineWidth = Math.max(2, width * .07); context.stroke(); } context.restore(); }

/** 仅对已拍摄 Canvas 做一次本地 landmark 渲染；失败时保留原自拍，不阻塞留言。 */
async function applySelfieEffect(canvas) {
  const effect = $("selfie-effect").value;
  if (effect === "natural") return;
  const landmarker = await faceLandmarker();
  const result = landmarker.detect(canvas);
  const landmarks = result.faceLandmarks?.[0];
  if (!landmarks) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const leftEye = point(landmarks, 33, canvas.width, canvas.height);
  const rightEye = point(landmarks, 263, canvas.width, canvas.height);
  const nose = point(landmarks, 1, canvas.width, canvas.height);
  const mouth = point(landmarks, 13, canvas.width, canvas.height);
  const forehead = point(landmarks, 10, canvas.width, canvas.height);
  const chin = point(landmarks, 152, canvas.width, canvas.height);
  if (!leftEye || !rightEye || !nose || !mouth || !forehead || !chin) return;
  const eyeDistance = distance(leftEye, rightEye); const angle = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
  const center = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 }; const faceHeight = distance(forehead, chin);
  if (eyeDistance < 8 || faceHeight < 20) return;
  if (effect === "bigHead" || effect === "faceWarp" || effect === "bigEyes") {
    const scale = effect === "bigHead" ? 1.18 : effect === "faceWarp" ? .86 : 1;
    const radius = effect === "bigEyes" ? eyeDistance * .42 : faceHeight * .56;
    const source = document.createElement("canvas"); source.width = canvas.width; source.height = canvas.height;
    source.getContext("2d").drawImage(canvas, 0, 0);
    context.save(); context.beginPath(); context.arc(center.x, center.y, radius, 0, Math.PI * 2); context.clip();
    context.translate(center.x, center.y); context.scale(scale, scale); context.translate(-center.x, -center.y); context.drawImage(source, 0, 0); context.restore();
    if (effect === "bigEyes") { drawEllipse(context, leftEye, eyeDistance * .7, eyeDistance * .52, angle, "rgba(255,255,255,.24)"); drawEllipse(context, rightEye, eyeDistance * .7, eyeDistance * .52, angle, "rgba(255,255,255,.24)"); }
    return;
  }
  context.save(); context.translate(center.x, center.y); context.rotate(angle);
  if (effect === "bunnyEars") {
    context.fillStyle = "#f7a6c4"; context.strokeStyle = "#3e1c32"; context.lineWidth = Math.max(3, eyeDistance * .08);
    for (const offset of [-eyeDistance * .44, eyeDistance * .44]) { context.beginPath(); context.ellipse(offset, -faceHeight * .58, eyeDistance * .22, faceHeight * .42, 0, 0, Math.PI * 2); context.fill(); context.stroke(); }
  } else if (effect === "partyWig") {
    context.fillStyle = "#bb4dea"; for (let index = -3; index <= 3; index += 1) { context.beginPath(); context.arc(index * eyeDistance * .24, -faceHeight * .42, eyeDistance * .27, Math.PI, 0); context.fill(); }
  } else if (effect === "goofyGlasses" || effect === "sunglasses") {
    const dark = effect === "sunglasses" ? "rgba(16,20,27,.9)" : "rgba(103,225,255,.84)";
    drawEllipse(context, { x: -eyeDistance / 2, y: 0 }, eyeDistance * .95, eyeDistance * .72, 0, dark, "#fff"); drawEllipse(context, { x: eyeDistance / 2, y: 0 }, eyeDistance * .95, eyeDistance * .72, 0, dark, "#fff"); context.strokeStyle = "#fff"; context.lineWidth = Math.max(2, eyeDistance * .08); context.beginPath(); context.moveTo(-eyeDistance * .1, 0); context.lineTo(eyeDistance * .1, 0); context.stroke();
  } else if (effect === "alienEyes") {
    drawEllipse(context, { x: -eyeDistance / 2, y: 0 }, eyeDistance * .9, eyeDistance * .72, 0, "#a5ff70", "#fff"); drawEllipse(context, { x: eyeDistance / 2, y: 0 }, eyeDistance * .9, eyeDistance * .72, 0, "#a5ff70", "#fff");
  } else if (effect === "fakeMustache") {
    context.fillStyle = "#3a221b"; for (const offset of [-eyeDistance * .22, eyeDistance * .22]) { context.beginPath(); context.ellipse(offset, eyeDistance * .45, eyeDistance * .32, eyeDistance * .16, offset < 0 ? -.45 : .45, 0, Math.PI * 2); context.fill(); }
  } else if (effect === "paperBag") {
    context.fillStyle = "rgba(179,132,73,.9)"; context.fillRect(-eyeDistance * 1.25, -faceHeight * .58, eyeDistance * 2.5, faceHeight * 1.35); context.globalCompositeOperation = "destination-out"; drawEllipse(context, { x: -eyeDistance / 2, y: 0 }, eyeDistance * .52, eyeDistance * .34, 0, "#000"); drawEllipse(context, { x: eyeDistance / 2, y: 0 }, eyeDistance * .52, eyeDistance * .34, 0, "#000");
  }
  context.restore();
}

function errorMessage(error) {
  if (error?.name === "NotAllowedError") return "Microphone access was not allowed. You can enable it in your browser settings and try again.";
  if (error?.name === "NotFoundError") return "No microphone was found on this device.";
  return error?.message || "This guest link is no longer available.";
}

async function responseJSON(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.code || "Request failed. Please try again.");
  return body;
}

function supportedRecorderType() {
  // Host 的本地导入器当前只接受 Safari 的 MP4/AAC；Android 常见 WebM 不上传，
  // 避免让用户录完后收到不可恢复的格式错误。
  return ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
}

async function boot() {
  if (!slug || !/^[A-Za-z0-9_-]{32,}$/.test(slug)) throw new Error("This guest link is no longer available.");
  const config = await responseJSON(await fetch(`${api}/v1/guest/${encodeURIComponent(slug)}/bootstrap`, { cache: "no-store", credentials: "omit" }));
  state.config = config;
  const type = window.MediaRecorder && supportedRecorderType();
  if (!navigator.mediaDevices?.getUserMedia || !type) {
    throw new Error("This browser cannot securely create the required audio format. Please use Safari on iPhone or iPad, or leave a message at the host’s Booth.");
  }
  $("limits").textContent = `Audio is limited to ${Math.floor(config.maxAudioBytes / 1024 / 1024)} MB. Photos are compressed before they are sent.`;
  status("The host is accepting private messages.");
  $("consent-panel").hidden = false;
}

$("consent").addEventListener("change", (event) => { $("begin").disabled = !event.currentTarget.checked; });
$("begin").addEventListener("click", () => { $("consent-panel").hidden = true; $("composer").hidden = false; status("You can record your message now."); });

$("record").addEventListener("click", async () => {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    const mimeType = supportedRecorderType();
    state.chunks = [];
    state.recorder = new MediaRecorder(state.stream, { mimeType, audioBitsPerSecond: 96_000 });
    state.recorder.addEventListener("dataavailable", (event) => { if (event.data.size) state.chunks.push(event.data); });
    state.recorder.addEventListener("stop", finishRecording, { once: true });
    state.recorder.start(1000);
    $("record").disabled = true; $("stop").disabled = false; $("discard").disabled = true;
    status("Recording… Stop when you are ready.");
  } catch (error) { status(errorMessage(error)); }
});

$("stop").addEventListener("click", () => { if (state.recorder?.state === "recording") state.recorder.stop(); });
$("discard").addEventListener("click", clearRecording);

function clearRecording() {
  if (state.audio) URL.revokeObjectURL($("preview").src);
  state.audio = null; state.chunks = [];
  $("preview").hidden = true; setPhotoControls(true); $("send").disabled = true; $("discard").disabled = true; $("record").disabled = false; $("send-summary").textContent = "";
  status("The recording was discarded.");
}

function finishRecording() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  const audio = new Blob(state.chunks, { type: supportedRecorderType() });
  if (!audio.size || audio.size > state.config.maxAudioBytes) { clearRecording(); status("This recording is too large. Please leave a shorter message."); return; }
  state.audio = audio;
  $("preview").src = URL.createObjectURL(audio); $("preview").hidden = false;
  setPhotoControls(false); $("send").disabled = false; $("discard").disabled = false; $("stop").disabled = true; updateSendSummary();
  status("Listen to your recording, optionally add photos, then send it to the host.");
}

async function compressPhoto(file, applyEffect) {
  const maxBytes = state.config.maxPhotoBytes;
  // iOS Safari 对 createImageBitmap 的支持不完整（尤其是相册 HEIC），这里使用
  // 浏览器通用的 Image 解码后再转 JPEG。对象 URL 会立即释放，不保留 Guest 原图。
  const sourceURL = URL.createObjectURL(file);
  const image = new Image();
  try {
    await withTimeout(new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("This photo could not be opened. Choose another photo."));
      image.src = sourceURL;
    }), 15_000, "This photo took too long to open. Choose a JPEG or PNG photo and try again.");
    const longest = 1920; const scale = Math.min(1, longest / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare the selected photo.");
    // 不读取 EXIF 或把原图写入存储；Canvas 重绘只保留最终 JPEG 像素。
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (applyEffect && $("selfie-effect").value !== "natural") {
      try {
        await withTimeout(applySelfieEffect(canvas), 12_000, "This selfie effect took too long. Your original selfie will be used instead.");
      } catch (error) {
        // 人脸未识别、WASM 不可用或超时都不可阻断宾客提交；保留已经重绘的原自拍。
        console.warn("selfie_effect_fallback", { name: error?.name || "unknown" });
      }
    }
    for (let quality = 0.88; quality >= 0.4; quality -= 0.08) {
      const blob = await withTimeout(new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality)), 15_000, "This photo took too long to prepare. Choose a smaller JPEG or PNG photo and try again.");
      if (blob && blob.size <= maxBytes) return blob;
    }
  } finally {
    URL.revokeObjectURL(sourceURL);
  }
  throw new Error("A selected photo cannot be compressed enough. Choose a smaller photo.");
}

async function prepareSelectedPhotos(event) {
  // 异步处理期间 Event.currentTarget 在 Safari 中可能变为 null；必须在同步阶段
  // 固定 input 引用，确保 finally 无论成功、失败或超时都能恢复交互。
  const input = event.currentTarget;
  const isSelfie = input.id === "camera-photos";
  const files = [...input.files].slice(0, 6);
  if (!files.length) return;
  state.photosPreparing = true; $("send").disabled = true; setPhotoControls(true); updateSendSummary();
  try {
    state.photos = await Promise.all(files.map((file) => compressPhoto(file, isSelfie)));
    $("photo-list").replaceChildren(...state.photos.map((photo, index) => { const item = document.createElement("li"); item.textContent = `Photo ${index + 1}: ${Math.ceil(photo.size / 1024)} KB`; return item; }));
    if (input.files.length > 6) status("Only the first 6 photos were selected.");
  } catch (error) { state.photos = []; $("photo-list").replaceChildren(); status(errorMessage(error)); }
  finally { input.value = ""; state.photosPreparing = false; setPhotoControls(false); $("send").disabled = !state.audio; updateSendSummary(); }
}
$("take-photo").addEventListener("click", () => $("camera-photos").click());
$("choose-photos").addEventListener("click", () => $("library-photos").click());
$("camera-photos").addEventListener("change", prepareSelectedPhotos);
$("library-photos").addEventListener("change", prepareSelectedPhotos);

async function capability(kind) {
  return responseJSON(await fetch(`${api}/v1/guest/${encodeURIComponent(slug)}/capabilities`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }), cache: "no-store", credentials: "omit" }));
}
async function upload(kind, blob) {
  const cap = await capability(kind);
  // 浏览器禁止脚本手动设置 Content-Length；服务端以实际请求体再次校验大小。
  const response = await fetch(`${api}/v1/guest/uploads/${encodeURIComponent(cap.capability.split(".")[0])}`, { method: "PUT", headers: { authorization: `Bearer ${cap.capability}`, "content-type": blob.type }, body: blob, cache: "no-store", credentials: "omit" });
  return responseJSON(response);
}

$("send").addEventListener("click", async () => {
  if (!state.audio || state.photosPreparing) return;
  try {
    $("send").disabled = true; $("discard").disabled = true; setPhotoControls(true);
    status("Uploading your message securely… Keep this page open.");
    const audio = await upload("audio", state.audio);
    const photos = [];
    for (const photo of state.photos) photos.push(await upload("photo", photo));
    const final = await responseJSON(await fetch(`${api}/v1/guest/${encodeURIComponent(slug)}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audioUploadID: audio.uploadID, photoUploadIDs: photos.map((photo) => photo.uploadID) }), cache: "no-store", credentials: "omit" }));
    state.submissionID = final.submissionID;
    state.receipt = final.receipt;
    $("composer").hidden = true; $("saved-panel").hidden = false;
    status("Your message is waiting for the host to save it.");
    pollHostAcknowledgement();
  } catch (error) { $("send").disabled = false; $("discard").disabled = false; setPhotoControls(false); status(errorMessage(error)); }
});

async function pollHostAcknowledgement() {
  if (!state.receipt) return;
  try {
    // receipt 是 finalize 返回的 256-bit 不可枚举凭据；只允许读取 ACK 状态。
    const result = await responseJSON(await fetch(`${api}/v1/guest/${encodeURIComponent(slug)}/receipts/${encodeURIComponent(state.receipt)}`, { cache: "no-store", credentials: "omit" }));
    if (result.state === "saved_by_host") { $("saved-status").textContent = "Saved by the host."; return; }
  } catch (error) { if (String(error.message).includes("ended")) { $("saved-status").textContent = "This event has closed. The host may still save messages already received."; return; } }
  state.pollTimer = window.setTimeout(pollHostAcknowledgement, 5000);
}

window.addEventListener("pagehide", () => { state.stream?.getTracks().forEach((track) => track.stop()); if (state.pollTimer) clearTimeout(state.pollTimer); });
boot().catch((error) => { status(errorMessage(error)); });
