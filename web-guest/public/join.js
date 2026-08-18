/*
 * 网页端不把 QR slug、媒体 Blob 或 capability 写入 localStorage / IndexedDB。
 * 页面刷新会丢弃未发送内容，优先避免共享设备遗留宾客隐私。
 */
const api = "https://event-voice-booth-web-guest.event-voice-booth-web-guest.workers.dev";
const slug = location.pathname.split("/").filter(Boolean).at(-1);
const $ = (id) => document.getElementById(id);
const state = { config: null, recorder: null, stream: null, chunks: [], audio: null, photos: [], photoURLs: [], photosPreparing: false, isSending: false, submissionID: null, pollTimer: null };
const status = (message) => { $("status").textContent = message; };
const updateSendSummary = () => { $("send-summary").textContent = state.photosPreparing ? "Preparing photos securely…" : `This message will be sent with ${state.photos.length} photo${state.photos.length === 1 ? "" : "s"}.`; };
const setPhotoControls = (disabled) => { $("take-photo").disabled = disabled; $("choose-photos").disabled = disabled; };
const withTimeout = (promise, milliseconds, message) => Promise.race([promise, new Promise((_, reject) => window.setTimeout(() => reject(new Error(message)), milliseconds))]);
const clearPhotoURLs = () => { state.photoURLs.forEach((url) => URL.revokeObjectURL(url)); state.photoURLs = []; };

/**
 * 上传期间以不可关闭的模态提示占据视觉焦点，避免顶部状态文字被忽略。
 * 上传结束后可切换为带确认按钮的结果提示，并把焦点安全移到按钮。
 */
function showMessageDialog({ title, detail, busy, actionLabel = "Continue" }) {
  $("message-dialog-title").textContent = title;
  $("message-dialog-detail").textContent = detail;
  $("message-dialog-progress").hidden = !busy;
  const action = $("message-dialog-action");
  action.hidden = busy;
  action.textContent = actionLabel;
  $("message-dialog").hidden = false;
  if (!busy) action.focus({ preventScroll: true });
}

function hideMessageDialog() {
  $("message-dialog").hidden = true;
  if (!$("send").disabled && !$("composer").hidden) $("send").focus({ preventScroll: true });
}

$("message-dialog-action").addEventListener("click", hideMessageDialog);

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

/** 将自拍或相册照片仅在浏览器内压缩为不含 EXIF 的最终 JPEG。 */
async function compressPhoto(file) {
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
  const files = [...input.files].slice(0, 6);
  if (!files.length) return;
  state.photosPreparing = true; $("send").disabled = true; setPhotoControls(true); updateSendSummary();
  try {
    const prepared = await Promise.all(files.map(compressPhoto));
    clearPhotoURLs();
    state.photos = prepared;
    state.photoURLs = state.photos.map((photo) => URL.createObjectURL(photo));
    $("photo-list").replaceChildren(...prepared.map((photo, index) => {
      const item = document.createElement("li");
      const preview = document.createElement("img"); preview.src = state.photoURLs[index]; preview.alt = `Prepared photo ${index + 1}`;
      const detail = document.createElement("span"); detail.textContent = `${Math.ceil(photo.size / 1024)} KB`;
      item.append(preview, detail); return item;
    }));
    if (input.files.length > 6) status("Only the first 6 photos were selected.");
  } catch (error) { clearPhotoURLs(); state.photos = []; $("photo-list").replaceChildren(); status(errorMessage(error)); }
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
    state.isSending = true;
    $("send").disabled = true; $("discard").disabled = true; setPhotoControls(true);
    status("Uploading your message securely… Keep this page open.");
    showMessageDialog({
      title: "Sending your message",
      detail: "Keep this browser open. Do not close this page until you see that your message was sent.",
      busy: true,
    });
    const audio = await upload("audio", state.audio);
    const photos = [];
    for (const photo of state.photos) photos.push(await upload("photo", photo));
    const final = await responseJSON(await fetch(`${api}/v1/guest/${encodeURIComponent(slug)}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audioUploadID: audio.uploadID, photoUploadIDs: photos.map((photo) => photo.uploadID) }), cache: "no-store", credentials: "omit" }));
    state.submissionID = final.submissionID;
    state.receipt = final.receipt;
    $("composer").hidden = true; $("saved-panel").hidden = false;
    status("Your message is waiting for the host to save it.");
    showMessageDialog({
      title: "Message sent securely",
      detail: "Your upload is complete. You may now leave this page, or keep it open to see when the host saves your message.",
      busy: false,
    });
    pollHostAcknowledgement();
  } catch (error) {
    $("send").disabled = false; $("discard").disabled = false; setPhotoControls(false);
    const message = errorMessage(error);
    status(message);
    showMessageDialog({ title: "Upload not finished", detail: `${message} Your recording is still on this page. Close this message and tap Send to host to try again.`, busy: false, actionLabel: "Close" });
  } finally {
    state.isSending = false;
  }
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

// 支持 beforeunload 的浏览器会在上传未完成时给出系统级离页确认；浏览器出于
// 安全原因会忽略自定义文案，因此页面内模态弹窗仍是主要提醒方式。
window.addEventListener("beforeunload", (event) => {
  if (!state.isSending) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("pagehide", () => { state.stream?.getTracks().forEach((track) => track.stop()); clearPhotoURLs(); if (state.pollTimer) clearTimeout(state.pollTimer); });
boot().catch((error) => { status(errorMessage(error)); });
