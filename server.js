/*
 * A.R.M.O.R. BOT telemetry contract (POST /api/telemetry, JSON):
 * {
 *   "stationId":"ARMOR-01",
 *   "water":{"depthM":1.42,"lowWet":false,"mediumWet":false,"highWet":false},
 *   "power":{"batteryPercent":86,"batteryVoltage":13.2,"solarWatts":42,"chargeState":"bulk"},
 *   "stability":{"pitchDeg":1.2,"rollDeg":-0.8},
 *   "waterQuality":{"ph":7.2,"microplasticsPpl":120},
 *   "gps":{"latitude":16.558,"longitude":121.3,"satellites":9,"rssiDbm":-78,"snrDb":8.4,"radio":"LoRa 915 MHz"},
 *   "camera":{"online":true}
 * }
 * Optional x-api-key header must match API_KEY when API_KEY is configured.
 * Server response: {"ok":true,"alarm":{"visual":true,"acoustic":false},"status":"warning"}
 */
'use strict';
const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const CAMERA_URL = process.env.CAMERA_URL || '';
const CAMERA_USERNAME = process.env.CAMERA_USERNAME || '';
const CAMERA_PASSWORD = process.env.CAMERA_PASSWORD || '';
const CAMERA_TIMEOUT_MS = Math.max(1500, Number(process.env.CAMERA_TIMEOUT_MS || 8000));
const ROOT = __dirname;
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb', strict: true }));
let latest = null;
let lastDeviceAt = 0;
let demoCounter = 0;
const clients = new Set();
const MAX_DEPTH_M = 8;
function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function bool(value) { return value === true || value === 1 || value === 'true'; }
function statusFor(t) {
  const w = t.water || {};
  if (num(w.depthM) >= MAX_DEPTH_M * .7 || bool(w.highWet)) return 'critical';
  if (num(w.depthM) >= MAX_DEPTH_M * .4 || bool(w.mediumWet)) return 'warning';
  return 'normal';
}
function alarmFor(status) { return { visual: status !== 'normal', acoustic: status === 'critical' }; }
function normalizePayload(payload) {
  const src = payload && payload.telemetry && typeof payload.telemetry === 'object' ? payload.telemetry : payload;
  const water = src.water || src.waterLevel || src.sensors || {};
  const power = src.power || src.battery || {};
  const stability = src.stability || src.imu || src.gyroscope || {};
  const waterQuality = src.waterQuality || src.quality || {};
  const gps = src.gps || src.location || {};
  const camera = src.camera || {};
  return {
    stationId: String(src.stationId || src.deviceId || src.id || 'ARMOR-01').slice(0, 80),
    timestamp: src.timestamp || new Date().toISOString(),
    water: { depthM: Math.max(0, Math.min(MAX_DEPTH_M, num(water.depthM ?? water.depth_m ?? water.depth ?? water.waterDepthM))), lowWet: bool(water.lowWet ?? water.low ?? water.lowSensorWet), mediumWet: bool(water.mediumWet ?? water.medium ?? water.mediumSensorWet), highWet: bool(water.highWet ?? water.high ?? water.highSensorWet) },
    power: { batteryPercent: Math.max(0, Math.min(100, num(power.batteryPercent ?? power.batteryPct ?? power.soc))), batteryVoltage: Math.max(0, num(power.batteryVoltage ?? power.voltageV ?? power.voltage)), solarWatts: Math.max(0, num(power.solarWatts ?? power.solarPowerW ?? power.solarW)), chargeState: String(power.chargeState || power.mpptState || power.state || 'idle').toLowerCase() },
    stability: { pitchDeg: Math.max(-90, Math.min(90, num(stability.pitchDeg ?? stability.pitch ?? stability.pitchDegrees))), rollDeg: Math.max(-90, Math.min(90, num(stability.rollDeg ?? stability.roll ?? stability.rollDegrees))) },
    waterQuality: { ph: Math.max(0, Math.min(14, num(waterQuality.ph ?? waterQuality.pH, 7))), microplasticsPpl: Math.max(0, num(waterQuality.microplasticsPpl ?? waterQuality.microplasticPpl ?? waterQuality.particlesPerLitre ?? waterQuality.particlesPerLiter)) },
    gps: { latitude: Math.max(-90, Math.min(90, num(gps.latitude ?? gps.lat))), longitude: Math.max(-180, Math.min(180, num(gps.longitude ?? gps.lon ?? gps.lng))), satellites: Math.max(0, Math.min(99, num(gps.satellites ?? gps.satelliteCount ?? gps.sats))), rssiDbm: Math.max(-200, Math.min(0, num(gps.rssiDbm ?? gps.rssi, -120))), snrDb: Math.max(-50, Math.min(50, num(gps.snrDb ?? gps.snr))), radio: String(gps.radio || gps.link || 'LoRa 915 MHz').slice(0, 80) },
    camera: { online: bool(camera.online ?? camera.connected) }
  };
}
function demoTelemetry() {
  demoCounter++;
  const sec = Date.now() / 1000;
  return { stationId: 'ARMOR-01', timestamp: new Date().toISOString(), water: { depthM: Number(Math.max(.35, Math.min(2.65, 1.42 + Math.sin(sec / 23) * .45 + Math.sin(sec / 8) * .08)).toFixed(2)), lowWet: true, mediumWet: false, highWet: false }, power: { batteryPercent: Math.round(86 + Math.sin(sec / 70) * 3), batteryVoltage: 13.2, solarWatts: Math.round(Math.max(0, 40 + Math.sin(sec / 12) * 17)), chargeState: 'bulk' }, stability: { pitchDeg: Number((1.2 + Math.sin(sec / 4) * 1.3).toFixed(1)), rollDeg: Number((-0.8 + Math.cos(sec / 5) * 1.1).toFixed(1)) }, waterQuality: { ph: Number((7.2 + Math.sin(sec / 19) * .15).toFixed(1)), microplasticsPpl: Math.round(120 + Math.sin(sec / 11) * 24) }, gps: { latitude: Number((16.558 + Math.sin(sec / 60) * .0002).toFixed(6)), longitude: Number((121.3 + Math.cos(sec / 60) * .0002).toFixed(6)), satellites: 9, rssiDbm: -78, snrDb: 8.4, radio: 'LoRa 915 MHz' }, camera: { online: Boolean(CAMERA_URL) } };
}
function isDeviceOnline() { return Boolean(latest && Date.now() - lastDeviceAt < 6000); }
function currentFrame() { const demo = !isDeviceOnline(); const telemetry = demo ? demoTelemetry() : latest; const status = statusFor(telemetry); return { type: 'telemetry', demo, status, telemetry, alarm: alarmFor(status), serverTime: new Date().toISOString() }; }
function publish() { const frame = currentFrame(); const data = `data: ${JSON.stringify(frame)}\n\n`; for (const res of clients) { try { res.write(data); } catch { clients.delete(res); } } }
function requireApiKey(req, res, next) { if (API_KEY && req.get('x-api-key') !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized: send the configured x-api-key header.' }); next(); }
app.get('/api/health', (req, res) => res.json({ ok: true, deviceOnline: isDeviceOnline(), demo: !isDeviceOnline(), clients: clients.size, cameraConfigured: Boolean(CAMERA_URL), serverTime: new Date().toISOString() }));
app.post('/api/telemetry', requireApiKey, (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'Send telemetry as application/json.' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ ok: false, error: 'The request body must be a JSON object.' });
  latest = normalizePayload(req.body); lastDeviceAt = Date.now(); const status = statusFor(latest); const alarm = alarmFor(status); publish();
  res.json({ ok: true, alarm, status, receivedAt: new Date(lastDeviceAt).toISOString() });
});
app.get('/api/stream', (req, res) => {
  res.status(200); res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); if (res.flushHeaders) res.flushHeaders();
  res.write(`retry: 2000\n\n`); clients.add(res); res.write(`data: ${JSON.stringify(currentFrame())}\n\n`);
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); clients.delete(res); } }, 15000);
  req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
});
function cameraRequest(req, res) {
  if (!CAMERA_URL) return res.status(503).type('text/plain').send('Camera is not configured. Set CAMERA_URL to the camera MJPEG stream URL and restart the server.');
  let target; try { target = new URL(CAMERA_URL); } catch { return res.status(500).type('text/plain').send('CAMERA_URL is not a valid URL. Check the server environment variable.'); }
  if (!['http:', 'https:'].includes(target.protocol)) return res.status(400).type('text/plain').send('CAMERA_URL must use HTTP or HTTPS.');
  const client = target.protocol === 'https:' ? https : http; const headers = { Accept: 'multipart/x-mixed-replace, image/jpeg, */*', 'User-Agent': 'ARMOR-BOT-Camera-Proxy/1.0' };
  if (CAMERA_USERNAME || CAMERA_PASSWORD) headers.Authorization = 'Basic ' + Buffer.from(`${CAMERA_USERNAME}:${CAMERA_PASSWORD}`).toString('base64');
  const upstream = client.request(target, { method: 'GET', headers, timeout: CAMERA_TIMEOUT_MS }, (up) => {
    if (up.statusCode < 200 || up.statusCode >= 300) { res.status(up.statusCode || 502).type('text/plain').end(`Camera returned HTTP ${up.statusCode}. Check the camera URL, credentials and stream permissions.`); up.resume(); return; }
    res.status(200); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const contentType = up.headers['content-type'] || 'multipart/x-mixed-replace; boundary=--myboundary'; res.setHeader('Content-Type', contentType); up.pipe(res);
    up.on('error', () => { if (!res.headersSent) res.status(502); res.end(); }); req.on('close', () => upstream.destroy());
  });
  upstream.on('timeout', () => { upstream.destroy(new Error('Camera request timed out')); });
  upstream.on('error', (err) => { if (!res.headersSent) res.status(502).type('text/plain'); if (!res.writableEnded) res.end(`Unable to reach the IP camera: ${err.message}. Check network access, CAMERA_URL and credentials.`); });
  upstream.end();
}
app.get('/api/camera', cameraRequest);
app.get('/manifest.webmanifest', (req, res) => { res.type('application/manifest+json').send(JSON.stringify({ id: '/', name: 'A.R.M.O.R. BOT Flood Monitor', short_name: 'A.R.M.O.R. BOT', description: 'Flood, power and water-quality monitoring', start_url: '/', scope: '/', display: 'standalone', background_color: '#0b1115', theme_color: '#0b1115', orientation: 'any', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] })); });
app.get('/icon.svg', (req, res) => { res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#0b1115"/><rect x="19" y="19" width="90" height="90" rx="22" fill="#10262b" stroke="#55d6e8" stroke-width="3"/><path d="M32 78h15V49h13v29h13V37h13v41h13" fill="none" stroke="#55d6e8" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`); });
app.get('/service-worker.js', (req, res) => { res.type('application/javascript').set('Service-Worker-Allowed', '/').send(`'use strict';const CACHE='armor-bot-shell-v1';const SHELL=['/','/style.css','/script.js','/manifest.webmanifest','/icon.svg'];self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()))});self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});self.addEventListener('fetch',event=>{const request=event.request;const url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok&&['/','/style.css','/script.js','/manifest.webmanifest','/icon.svg'].includes(url.pathname)){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy))}return response}).catch(()=>caches.match('/'))))});`); });
app.use((req, res, next) => { if (['/server.js', '/package.json', '/package-lock.json'].includes(req.path)) return res.status(404).type('text/plain').send('Not found'); next(); });
app.use(express.static(ROOT, { index: 'index.html', dotfiles: 'deny', etag: true, maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.use((err, req, res, next) => { if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Invalid JSON. Check the ESP32 request body.' }); console.error(err); if (!res.headersSent) res.status(500).json({ ok: false, error: 'Unexpected server error.' }); });
const tick = setInterval(publish, 1000);
server.listen(PORT, '0.0.0.0', () => console.log(`A.R.M.O.R. BOT is listening on http://localhost:${PORT} (${API_KEY ? 'API key required' : 'API key optional'})`));
function shutdown() { clearInterval(tick); for (const res of clients) { try { res.end(); } catch {} } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
