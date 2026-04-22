/* =====================================================
   RIDEGUARD – script.js
   Mobile Safety Command Center
   Simulated WebSocket + Real-time IoT dashboard
   ===================================================== */

/* ── MOCK WebSocket JSON STRUCTURE ──
{
  "ts": 1700000000000,          // Unix timestamp ms
  "gps": {
    "lat": 14.5995,
    "lng": 120.9842,
    "speed": 42,                // km/h
    "heading": 178,             // degrees
    "fix": true
  },
  "mpu": {
    "gforce": 0.98,             // G-force magnitude
    "pitch": 2.4,               // degrees
    "roll": -1.1,               // degrees
    "yaw": 178                  // degrees
  },
  "mq3": {
    "bac": 0.02,                // Blood Alcohol Content %
    "raw": 120                  // Analog ADC value
  },
  "sim": {
    "signal": 4,                // 0-5 bars
    "type": "4G",
    "connected": true
  },
  "battery": {
    "pct": 87,
    "voltage": 3.92,
    "current": 142,
    "charging": false
  },
  "alerts": {
    "fall": false,
    "geofence": false,
    "lowBattery": false
  }
}
*/

"use strict";

/* ── CONSTANTS ── */
const GEOFENCE_CENTER = { lat: 14.5995, lng: 120.9842 };
const GEOFENCE_RADIUS_KM = 2.0;
const FALL_G_THRESHOLD = 2.8;
const SPIKE_G_THRESHOLD = 1.8;
const ALCOHOL_DANGER_BAC = 0.05;
const LOW_BATTERY_THRESHOLD = 20;
const UPDATE_INTERVAL_MS = 1000;   // Simulate 1Hz sensor tick
const CHART_WINDOW = 40;           // Data points in G-force chart

/* ── STATE ── */
const state = {
  sensorData: null,
  gforceHistory: new Array(CHART_WINDOW).fill(1.0),
  gforceMax: 1.0,
  gforceSpikes: 0,
  trailPoints: [],
  emergencyActive: false,
  lastUpdateTs: Date.now(),
  geofenceBreached: false,
  incidentLog: [],
  map: null,
  fsMap: null,
  helmetMarker: null,
  fsHelmetMarker: null,
  trailPolyline: null,
  fsTrailPolyline: null,
  geofenceCircle: null,
  fsGeofenceCircle: null,
  compassAngle: 178,
  lowBatAlerted: false,
  rideStartTime: Date.now(),
};

/* ──────────────────────────────────────────────────── */
/*  SIMULATED SENSOR DATA GENERATOR                    */
/* ──────────────────────────────────────────────────── */
function generateSensorData(prev) {
  const now = Date.now();
  const t = now / 1000;

  // GPS – simulate slow drift around Manila
  const baseLat = 14.5995, baseLng = 120.9842;
  const latOff  = Math.sin(t / 90) * 0.008 + Math.cos(t / 130) * 0.004;
  const lngOff  = Math.cos(t / 90) * 0.010 + Math.sin(t / 120) * 0.005;
  const lat = baseLat + latOff;
  const lng = baseLng + lngOff;
  const speed = Math.max(0, 40 + Math.sin(t / 20) * 15 + (Math.random() - 0.5) * 5);

  // G-Force – normally ~1G, occasional bumps
  let gforce = 0.98 + Math.sin(t * 3.3) * 0.05 + (Math.random() - 0.5) * 0.1;
  // Rare spike simulation
  if (Math.random() < 0.03) gforce += 1.0 + Math.random() * 1.5;

  // MPU
  const pitch = Math.sin(t / 12) * 8 + (Math.random() - 0.5) * 2;
  const roll  = Math.cos(t / 10) * 12 + (Math.random() - 0.5) * 2;
  const yaw   = ((prev?.gps?.heading ?? 178) + (Math.random() - 0.5) * 8 + 360) % 360;

  // BAC – slowly rises or stays stable (mostly safe)
  const bac = prev?.mq3?.bac !== undefined
    ? Math.max(0, Math.min(0.25, prev.mq3.bac + (Math.random() - 0.51) * 0.003))
    : 0.02;

  // Signal
  const signal = Math.round(3 + Math.sin(t / 40) * 1.5);
  const sigType = signal >= 4 ? "4G" : signal >= 2 ? "3G" : "2G";

  // Battery – slowly drain
  const prevBatt = prev?.battery?.pct ?? 87;
  const battPct  = Math.max(0, prevBatt - 0.01 * Math.random());
  const voltage  = 3.0 + (battPct / 100) * 1.2;
  const current  = 120 + Math.random() * 40;

  return {
    ts: now,
    gps: { lat, lng, speed: Math.round(speed), heading: Math.round(yaw), fix: signal > 0 },
    mpu: { gforce: parseFloat(gforce.toFixed(3)), pitch: parseFloat(pitch.toFixed(1)), roll: parseFloat(roll.toFixed(1)), yaw: Math.round(yaw) },
    mq3: { bac: parseFloat(bac.toFixed(3)), raw: Math.round(bac * 5000) },
    sim: { signal: Math.min(5, Math.max(0, signal)), type: sigType, connected: signal > 0 },
    battery: { pct: parseFloat(battPct.toFixed(1)), voltage: parseFloat(voltage.toFixed(2)), current: Math.round(current), charging: false },
    alerts: {
      fall:        gforce > FALL_G_THRESHOLD,
      geofence:    calcDistKm(lat, lng, GEOFENCE_CENTER.lat, GEOFENCE_CENTER.lng) > GEOFENCE_RADIUS_KM,
      lowBattery:  battPct < LOW_BATTERY_THRESHOLD,
    },
  };
}

/* Haversine distance in km */
function calcDistKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ──────────────────────────────────────────────────── */
/*  G-FORCE CHART (Chart.js)                           */
/* ──────────────────────────────────────────────────── */
let gforceChart;

function initGforceChart() {
  const ctx = document.getElementById('gforceChart').getContext('2d');

  gforceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: new Array(CHART_WINDOW).fill(''),
      datasets: [{
        data: [...state.gforceHistory],
        borderColor: 'rgba(91,168,245,0.85)',
        backgroundColor: (ctx2) => {
          const grad = ctx2.chart.ctx.createLinearGradient(0, 0, 0, 90);
          grad.addColorStop(0, 'rgba(45,125,210,0.30)');
          grad.addColorStop(1, 'rgba(45,125,210,0.00)');
          return grad;
        },
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
      }],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: {
          min: 0, max: 4,
          grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false },
          ticks: {
            color: 'rgba(148,163,184,0.7)',
            font: { size: 9, family: 'JetBrains Mono' },
            maxTicksLimit: 5,
            callback: v => v + 'G',
          },
          border: { display: false },
        },
      },
    },
  });
}

function updateGforceChart(val) {
  state.gforceHistory.push(val);
  if (state.gforceHistory.length > CHART_WINDOW) state.gforceHistory.shift();

  // Color data points red on spike
  const colors = state.gforceHistory.map(v =>
    v > FALL_G_THRESHOLD ? 'rgba(230,57,70,0.9)' :
    v > SPIKE_G_THRESHOLD ? 'rgba(245,197,24,0.9)' :
    'rgba(91,168,245,0.85)'
  );

  gforceChart.data.datasets[0].data = [...state.gforceHistory];
  gforceChart.data.datasets[0].borderColor = colors[colors.length - 1];
  gforceChart.options.scales.y.max = Math.max(4, Math.ceil(Math.max(...state.gforceHistory) * 1.3));
  gforceChart.update('none');
}

/* ──────────────────────────────────────────────────── */
/*  COMPASS CANVAS                                      */
/* ──────────────────────────────────────────────────── */
function drawCompass(heading) {
  const canvas = document.getElementById('compassCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W/2, cy = H/2, r = W/2 - 8;
  ctx.clearRect(0, 0, W, H);

  // Outer ring
  const ringGrad = ctx.createRadialGradient(cx, cy, r-8, cx, cy, r);
  ringGrad.addColorStop(0, 'rgba(45,125,210,0.15)');
  ringGrad.addColorStop(1, 'rgba(45,125,210,0.40)');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI*2);
  ctx.strokeStyle = 'rgba(45,125,210,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = 'rgba(10,22,40,0.8)';
  ctx.fill();

  // Cardinal markers
  const dirs = ['N','E','S','W'];
  dirs.forEach((d, i) => {
    const angle = (i * 90 - 90) * Math.PI / 180;
    const tx = cx + (r - 16) * Math.cos(angle);
    const ty = cy + (r - 16) * Math.sin(angle) + 4;
    ctx.font = `bold 11px 'Orbitron',monospace`;
    ctx.fillStyle = d === 'N' ? '#e63946' : 'rgba(91,168,245,0.7)';
    ctx.textAlign = 'center';
    ctx.fillText(d, tx, ty);
  });

  // Tick marks
  for (let i = 0; i < 36; i++) {
    const a = (i * 10 - 90) * Math.PI / 180;
    const tickLen = i % 9 === 0 ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(cx + (r-2)*Math.cos(a), cy + (r-2)*Math.sin(a));
    ctx.lineTo(cx + (r-2-tickLen)*Math.cos(a), cy + (r-2-tickLen)*Math.sin(a));
    ctx.strokeStyle = i % 9 === 0 ? 'rgba(91,168,245,0.8)' : 'rgba(91,168,245,0.3)';
    ctx.lineWidth = i % 9 === 0 ? 2 : 1;
    ctx.stroke();
  }

  // Needle
  const needleAngle = (heading - 90) * Math.PI / 180;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(needleAngle);

  // North half (red)
  ctx.beginPath();
  ctx.moveTo(0, -(r-24));
  ctx.lineTo(-6, 0);
  ctx.lineTo(6, 0);
  ctx.closePath();
  ctx.fillStyle = '#e63946';
  ctx.fill();

  // South half (white)
  ctx.beginPath();
  ctx.moveTo(0, r-24);
  ctx.lineTo(-6, 0);
  ctx.lineTo(6, 0);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fill();

  ctx.restore();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(45,125,210,0.9)';
  ctx.fill();
}

/* ──────────────────────────────────────────────────── */
/*  LEAFLET MAP                                         */
/* ──────────────────────────────────────────────────── */
function initMap() {
  const mapEl = document.getElementById('leafletMap');
  state.map = L.map(mapEl, {
    center: [GEOFENCE_CENTER.lat, GEOFENCE_CENTER.lng],
    zoom: 15,
    zoomControl: true,
    attributionControl: false,
    preferCanvas: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© OSM',
  }).addTo(state.map);

  // Helmet marker
  const helmetIcon = L.divIcon({
    className: '',
    html: `<div style="
      width:32px;height:32px;
      background:linear-gradient(135deg,#1f4b96,#2d7dd2);
      border:3px solid #5ba8f5;
      border-radius:50%;
      display:flex;align-items:center;justify-content:center;
      font-size:14px;color:#fff;
      box-shadow:0 0 14px rgba(45,125,210,0.7);
    ">🪖</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });

  state.helmetMarker = L.marker([GEOFENCE_CENTER.lat, GEOFENCE_CENTER.lng], { icon: helmetIcon }).addTo(state.map);
  state.helmetMarker.bindPopup('<b style="color:#5ba8f5">Juan Dela Cruz</b><br><span style="color:#94a3b8;font-size:11px">Live Tracking</span>');

  // Geofence circle
  state.geofenceCircle = L.circle([GEOFENCE_CENTER.lat, GEOFENCE_CENTER.lng], {
    radius: GEOFENCE_RADIUS_KM * 1000,
    color: 'rgba(45,125,210,0.6)',
    fillColor: 'rgba(45,125,210,0.06)',
    fillOpacity: 1,
    weight: 1.5,
    dashArray: '6,6',
  }).addTo(state.map);

  // Trail polyline
  state.trailPolyline = L.polyline([], {
    color: 'rgba(91,168,245,0.5)',
    weight: 2,
    dashArray: '4,4',
  }).addTo(state.map);

  setTimeout(() => state.map.invalidateSize(), 400);
}

function initFullscreenMap() {
  if (state.fsMap) return;

  const mapEl = document.getElementById('fullscreenMap');
  state.fsMap = L.map(mapEl, {
    center: [GEOFENCE_CENTER.lat, GEOFENCE_CENTER.lng],
    zoom: 15,
    attributionControl: false,
    preferCanvas: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(state.fsMap);

  const helmetIcon = L.divIcon({
    className: '',
    html: `<div style="width:32px;height:32px;background:linear-gradient(135deg,#1f4b96,#2d7dd2);border:3px solid #5ba8f5;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff;box-shadow:0 0 14px rgba(45,125,210,0.7);">🪖</div>`,
    iconSize: [32, 32], iconAnchor: [16, 16],
  });

  state.fsHelmetMarker = L.marker([GEOFENCE_CENTER.lat, GEOFENCE_CENTER.lng], { icon: helmetIcon }).addTo(state.fsMap);
  state.fsGeofenceCircle = L.circle([GEOFENCE_CENTER.lat, GEOFENCE_CENTER.lng], {
    radius: GEOFENCE_RADIUS_KM * 1000, color: 'rgba(45,125,210,0.6)',
    fillColor: 'rgba(45,125,210,0.06)', fillOpacity: 1, weight: 1.5, dashArray: '6,6',
  }).addTo(state.fsMap);
  state.fsTrailPolyline = L.polyline([], { color: 'rgba(91,168,245,0.5)', weight: 2, dashArray: '4,4' }).addTo(state.fsMap);

  setTimeout(() => state.fsMap.invalidateSize(), 300);
}

function updateMap(gps) {
  if (!state.map) return;
  const latlng = [gps.lat, gps.lng];

  state.helmetMarker.setLatLng(latlng);
  state.map.panTo(latlng, { animate: true, duration: 0.8 });

  // Trail – keep last 20 points
  state.trailPoints.push(latlng);
  if (state.trailPoints.length > 20) state.trailPoints.shift();
  state.trailPolyline.setLatLngs(state.trailPoints);

  // Sync fullscreen map if open
  if (state.fsMap && state.fsHelmetMarker) {
    state.fsHelmetMarker.setLatLng(latlng);
    state.fsMap.panTo(latlng, { animate: true, duration: 0.8 });
    state.fsTrailPolyline.setLatLngs(state.trailPoints);
  }
}

/* ──────────────────────────────────────────────────── */
/*  UI UPDATE FUNCTIONS                                 */
/* ──────────────────────────────────────────────────── */

/* Status Bar */
function updateStatusBar(d) {
  // SIM
  const simEl = document.getElementById('simStatus');
  const sigText = document.getElementById('signalText');
  sigText.textContent = d.sim.type;
  simEl.className = 'status-pill ' + (d.sim.signal >= 3 ? 'good' : d.sim.signal >= 1 ? 'warn' : 'danger');
  const simIcon = simEl.querySelector('i');
  simIcon.className = `fa-solid fa-signal${d.sim.signal <= 1 ? '-weak' : d.sim.signal === 2 ? '-fair' : ''}`;
  simIcon.className = 'fa-solid fa-signal';

  // GPS
  const gpsEl = document.getElementById('gpsStatus');
  document.getElementById('gpsText').textContent = d.gps.fix ? 'FIX' : 'NO FIX';
  gpsEl.className = 'status-pill ' + (d.gps.fix ? 'good' : 'danger');

  // Battery
  const battEl = document.getElementById('batteryPill');
  const battText = document.getElementById('batteryText');
  battText.textContent = Math.round(d.battery.pct) + '%';
  battEl.className = 'status-pill ' + (d.battery.pct > 50 ? 'good' : d.battery.pct > 20 ? 'warn' : 'danger');
  const battIcon = document.getElementById('batteryIcon');
  if (d.battery.pct > 75) battIcon.className = 'fa-solid fa-battery-full';
  else if (d.battery.pct > 50) battIcon.className = 'fa-solid fa-battery-three-quarters';
  else if (d.battery.pct > 25) battIcon.className = 'fa-solid fa-battery-half';
  else if (d.battery.pct > 10) battIcon.className = 'fa-solid fa-battery-quarter';
  else battIcon.className = 'fa-solid fa-battery-empty';

  // Timestamp
  document.getElementById('lastSeen').textContent = 'just now';
}

/* Alcohol */
function updateAlcohol(mq3) {
  const bac = mq3.bac;
  const badge = document.getElementById('alcoholBadge');
  const label = document.getElementById('alcoholLabel');
  const bacEl  = document.getElementById('alcoholBac');
  const fill   = document.getElementById('alcoholMeterFill');
  const card   = document.getElementById('alcoholCard');

  const pct = Math.min(100, (bac / 0.25) * 100);
  fill.style.width = pct + '%';
  bacEl.textContent = bac.toFixed(3) + '%';

  if (bac >= ALCOHOL_DANGER_BAC) {
    badge.className = 'alcohol-badge danger';
    label.textContent = 'DANGER: HIGH ALCOHOL';
    card.style.setProperty('--card-border', 'rgba(230,57,70,0.45)');
    if (!state.emergencyActive) triggerEmergency('ALCOHOL DETECTED', 'fa-wine-bottle');
  } else {
    badge.className = 'alcohol-badge safe';
    label.textContent = 'SAFE TO RIDE';
    card.style.removeProperty('--card-border');
  }
}

/* Motion */
function updateMotion(mpu) {
  const gf = mpu.gforce;
  const el = document.getElementById('gforceVal');
  const statusEl = document.getElementById('gforceStatus');

  el.childNodes[0].textContent = gf.toFixed(2);

  // Update chart
  updateGforceChart(gf);

  // Track max & avg
  state.gforceMax = Math.max(state.gforceMax, gf);
  document.getElementById('maxG').textContent = state.gforceMax.toFixed(2) + 'G';
  const avg = state.gforceHistory.reduce((a, b) => a + b, 0) / state.gforceHistory.length;
  document.getElementById('avgG').textContent = avg.toFixed(2) + 'G';

  if (gf > FALL_G_THRESHOLD) {
    el.className = 'gforce-value spike-flash';
    statusEl.textContent = '⚠ IMPACT DETECTED';
    statusEl.className = 'gforce-status critical';
    state.gforceSpikes++;
    document.getElementById('spikeCount').textContent = state.gforceSpikes;
    if (!state.emergencyActive) triggerEmergency('FALL DETECTED', 'fa-person-falling-burst');
  } else if (gf > SPIKE_G_THRESHOLD) {
    el.className = 'gforce-value';
    statusEl.textContent = '⚡ HEAVY BUMP';
    statusEl.className = 'gforce-status warning';
    state.gforceSpikes++;
    document.getElementById('spikeCount').textContent = state.gforceSpikes;
  } else {
    el.className = 'gforce-value';
    statusEl.textContent = 'Normal';
    statusEl.className = 'gforce-status';
  }
}

/* Orientation */
function updateOrientation(mpu) {
  // Compass
  state.compassAngle = mpu.yaw;
  drawCompass(mpu.yaw);

  // Pitch / Roll / Yaw values
  document.getElementById('pitchVal').textContent = (mpu.pitch >= 0 ? '+' : '') + mpu.pitch.toFixed(1) + '°';
  document.getElementById('rollVal').textContent  = (mpu.roll  >= 0 ? '+' : '') + mpu.roll.toFixed(1)  + '°';
  document.getElementById('yawVal').textContent   = Math.round(mpu.yaw) + '°';

  // Bar widths (mapped to 0–100% centered at 50%)
  document.getElementById('pitchBar').style.width = (50 + mpu.pitch * 1.2) + '%';
  document.getElementById('rollBar').style.width  = (50 + mpu.roll  * 1.2) + '%';
  document.getElementById('yawBar').style.width   = (mpu.yaw / 360) * 100  + '%';

  // Fall risk from roll angle
  const absRoll = Math.abs(mpu.roll);
  const riskEl  = document.getElementById('fallRisk');
  const riskLvl = document.getElementById('fallRiskLevel');
  if (absRoll > 40) {
    riskLvl.textContent = 'HIGH';
    riskEl.className = 'fall-risk crit';
    riskLvl.style.color = 'var(--accent-red)';
  } else if (absRoll > 20) {
    riskLvl.textContent = 'MEDIUM';
    riskEl.className = 'fall-risk warn';
    riskLvl.style.color = 'var(--accent-yellow)';
  } else {
    riskLvl.textContent = 'LOW';
    riskEl.className = 'fall-risk';
    riskLvl.style.color = 'var(--accent-green2)';
  }
}

/* GPS UI */
function updateGpsUI(gps) {
  document.getElementById('coordLat').textContent = Math.abs(gps.lat).toFixed(4) + '° ' + (gps.lat >= 0 ? 'N' : 'S');
  document.getElementById('coordLng').textContent = Math.abs(gps.lng).toFixed(4) + '° ' + (gps.lng >= 0 ? 'E' : 'W');
  document.getElementById('coordSpeed').innerHTML = `<i class="fa-solid fa-gauge"></i> ${gps.speed} km/h`;

  // Geofence
  const outside = calcDistKm(gps.lat, gps.lng, GEOFENCE_CENTER.lat, GEOFENCE_CENTER.lng) > GEOFENCE_RADIUS_KM;
  const fenceEl = document.getElementById('geofenceStatus');
  if (outside && !state.geofenceBreached) {
    state.geofenceBreached = true;
    fenceEl.className = 'geofence-status outside';
    fenceEl.innerHTML = '<i class="fa-solid fa-draw-polygon"></i> OUTSIDE ZONE';
    showToast('⚠ Rider has left the geofence zone!', 'warn');
    addIncident({ type: 'info', icon: 'fa-draw-polygon', title: 'GEOFENCE EXIT', detail: `Rider exited safe zone at ${formatTime(new Date())}. Last coords: ${gps.lat.toFixed(4)}, ${gps.lng.toFixed(4)}` });
  } else if (!outside && state.geofenceBreached) {
    state.geofenceBreached = false;
    fenceEl.className = 'geofence-status';
    fenceEl.innerHTML = '<i class="fa-solid fa-draw-polygon"></i> INSIDE ZONE';
    showToast('✅ Rider is back inside geofence', 'success');
  }
}

/* Battery UI */
function updateBatteryUI(battery) {
  const pct = battery.pct;
  document.getElementById('batteryPct').textContent = Math.round(pct) + '%';
  document.getElementById('battVoltage').textContent = battery.voltage.toFixed(2) + 'V';
  document.getElementById('battCurrent').textContent = battery.current + 'mA';

  const hours = Math.floor(((pct / 100) * 5000) / battery.current);
  const mins  = Math.floor((((pct / 100) * 5000) / battery.current - hours) * 60);
  document.getElementById('battLife').textContent = `${hours}h ${mins}m`;

  const fill = document.getElementById('batteryFill');
  fill.style.width = pct + '%';
  if (pct > 50) {
    fill.className = 'battery-fill';
    document.getElementById('battStatus').textContent = 'GOOD';
    document.getElementById('battStatus').className = 'bstat-val green';
  } else if (pct > 20) {
    fill.className = 'battery-fill medium';
    document.getElementById('battStatus').textContent = 'MODERATE';
    document.getElementById('battStatus').className = 'bstat-val yellow';
  } else {
    fill.className = 'battery-fill low';
    document.getElementById('battStatus').textContent = 'LOW';
    document.getElementById('battStatus').className = 'bstat-val red';
    if (!state.lowBatAlerted) {
      state.lowBatAlerted = true;
      showToast(`🔋 Low battery: ${Math.round(pct)}%. Please charge soon.`, 'warn');
    }
  }

  // Sync status bar battery
  document.getElementById('batteryText').textContent = Math.round(pct) + '%';
}

/* ──────────────────────────────────────────────────── */
/*  EMERGENCY OVERLAY                                   */
/* ──────────────────────────────────────────────────── */
let emergencyDebounce = null;

function triggerEmergency(type, icon) {
  if (state.emergencyActive) return;
  state.emergencyActive = true;

  document.getElementById('emergencyType').textContent = type;
  document.getElementById('emergencyTypeIcon').className = `fa-solid ${icon}`;
  document.getElementById('emergencyTime').textContent = formatTime(new Date());

  if (state.sensorData?.gps) {
    document.getElementById('emergencyLocation').textContent =
      `${state.sensorData.gps.lat.toFixed(4)}°N, ${state.sensorData.gps.lng.toFixed(4)}°E`;
  }

  document.getElementById('emergencyOverlay').classList.remove('hidden');
  document.getElementById('smsStatusText').textContent = 'Sending SMS via SIM800L...';

  // Simulate SMS sent after 2s
  setTimeout(() => {
    document.getElementById('smsStatusText').textContent = '✅ SMS sent to 2 contacts';
    const smsEl = document.getElementById('smsStatus');
    smsEl.style.borderColor = 'rgba(6,214,160,0.4)';
    smsEl.style.color = 'var(--accent-green2)';
    smsEl.querySelector('i').className = 'fa-solid fa-check-circle';
    smsEl.querySelector('i').style.animation = 'none';
  }, 2000);

  // Add to incident log
  addIncident({
    type: type.toLowerCase().includes('fall') ? 'fall' : type.toLowerCase().includes('alcohol') ? 'alcohol' : 'sos',
    icon: icon,
    title: type,
    detail: `Auto-detected at ${formatTime(new Date())}. SMS alert sent via SIM800L. Coordinates: ${state.sensorData?.gps?.lat?.toFixed(4) ?? 'N/A'}, ${state.sensorData?.gps?.lng?.toFixed(4) ?? 'N/A'}`,
  });

  // Haptic feedback simulation
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
}

function dismissEmergency() {
  state.emergencyActive = false;
  document.getElementById('emergencyOverlay').classList.add('hidden');
  // Reset SMS status color
  const smsEl = document.getElementById('smsStatus');
  smsEl.style.borderColor = '';
  smsEl.style.color = '';
  smsEl.querySelector('i').className = 'fa-solid fa-paper-plane';
  smsEl.querySelector('i').style.animation = '';
  showToast('Emergency dismissed', 'info');
}

/* ──────────────────────────────────────────────────── */
/*  INCIDENT LOG                                        */
/* ──────────────────────────────────────────────────── */
function addIncident(incident) {
  incident.id = Date.now();
  incident.timestamp = new Date();
  state.incidentLog.unshift(incident);
  renderIncidentLog();
}

function renderIncidentLog() {
  const list = document.getElementById('incidentList');
  document.getElementById('logCount').textContent = state.incidentLog.length;

  list.innerHTML = state.incidentLog.slice(0, 10).map(inc => {
    const iconMap = { fall: 'fa-person-falling-burst', alcohol: 'fa-wine-bottle', sos: 'fa-bell-exclamation', info: inc.icon || 'fa-circle-info' };
    const icon = iconMap[inc.type] || 'fa-circle-info';
    const typeColor = { fall: 'red', alcohol: 'yellow', sos: 'red', info: 'blue' }[inc.type] || 'blue';
    return `
      <div class="incident-card" onclick="toggleIncident(${inc.id})" data-id="${inc.id}">
        <div class="incident-icon ${inc.type}"><i class="fa-solid ${icon}"></i></div>
        <div class="incident-body">
          <div class="incident-title" style="color:var(--${typeColor === 'red' ? 'accent-red' : typeColor === 'yellow' ? 'accent-yellow' : 'sky-light'})">${inc.title}</div>
          <div class="incident-time">${formatTime(inc.timestamp)}</div>
          <div class="incident-detail" id="detail-${inc.id}">${inc.detail}</div>
        </div>
        <i class="incident-chevron fa-solid fa-chevron-right" id="chev-${inc.id}"></i>
      </div>
    `;
  }).join('');
}

function toggleIncident(id) {
  const detail = document.getElementById(`detail-${id}`);
  const chev   = document.getElementById(`chev-${id}`);
  if (detail) detail.classList.toggle('open');
  if (chev) chev.classList.toggle('open');
}
window.toggleIncident = toggleIncident;

/* ──────────────────────────────────────────────────── */
/*  TOAST NOTIFICATIONS                                  */
/* ──────────────────────────────────────────────────── */
function showToast(msg, type = 'info', duration = 3500) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { info: 'fa-circle-info', warn: 'fa-triangle-exclamation', danger: 'fa-circle-exclamation', success: 'fa-circle-check' };
  toast.innerHTML = `<i class="fa-solid ${icons[type] || 'fa-circle-info'}"></i><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fadeout');
    setTimeout(() => toast.remove(), 350);
  }, duration);
}

/* ──────────────────────────────────────────────────── */
/*  HELPERS                                             */
/* ──────────────────────────────────────────────────── */
function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ──────────────────────────────────────────────────── */
/*  MAIN SIMULATION LOOP                               */
/* ──────────────────────────────────────────────────── */
function tick() {
  state.sensorData = generateSensorData(state.sensorData);
  const d = state.sensorData;

  updateStatusBar(d);
  updateAlcohol(d.mq3);
  updateMotion(d.mpu);
  updateOrientation(d.mpu);
  updateGpsUI(d.gps);
  updateMap(d.gps);
  updateBatteryUI(d.battery);
}

/* ──────────────────────────────────────────────────── */
/*  EVENT LISTENERS                                     */
/* ──────────────────────────────────────────────────── */
function setupEvents() {
  // SOS Button
  document.getElementById('sosFab').addEventListener('click', () => {
    triggerEmergency('MANUAL SOS', 'fa-bell-exclamation');
    showToast('🚨 SOS activated! Alerting emergency contacts…', 'danger', 5000);
    if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 500]);
  });

  // Emergency dismiss
  document.getElementById('emergencyDismiss').addEventListener('click', dismissEmergency);
  document.getElementById('emergencyCancelBtn').addEventListener('click', dismissEmergency);

  // Map expand
  document.getElementById('mapExpandBtn').addEventListener('click', () => {
    const fs = document.getElementById('mapFullscreen');
    fs.classList.remove('hidden');
    initFullscreenMap();
    if (state.fsMap) {
      setTimeout(() => {
        state.fsMap.invalidateSize();
        if (state.sensorData?.gps) state.fsMap.setView([state.sensorData.gps.lat, state.sensorData.gps.lng], 15);
      }, 300);
    }
  });

  document.getElementById('mapFsClose').addEventListener('click', () => {
    document.getElementById('mapFullscreen').classList.add('hidden');
  });
}

/* ──────────────────────────────────────────────────── */
/*  INIT INCIDENT LOG (seed with historical data)      */
/* ──────────────────────────────────────────────────── */
function seedIncidentLog() {
  const now = Date.now();
  [
    { type: 'info',    icon: 'fa-shield-check', title: 'RIDE STARTED', detail: 'Helmet sensors online. All systems nominal. GPS fix acquired.', ts: now - 14 * 60000 },
    { type: 'info',    icon: 'fa-draw-polygon', title: 'ENTERED GEOFENCE', detail: 'Rider entered designated safe zone at 14:32:10.', ts: now - 10 * 60000 },
    { type: 'alcohol', icon: 'fa-wine-bottle',  title: 'ALCOHOL CHECK', detail: 'BAC reading 0.018% – Within safe threshold. Ride permitted.', ts: now - 5 * 60000 },
  ].reverse().forEach(inc => {
    state.incidentLog.push({ ...inc, id: inc.ts, timestamp: new Date(inc.ts) });
  });
  renderIncidentLog();
}

/* ──────────────────────────────────────────────────── */
/*  BOOTSTRAP                                           */
/* ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Init subsystems
  initGforceChart();
  drawCompass(178);
  initMap();
  setupEvents();
  seedIncidentLog();

  // Initial sensor tick immediately
  tick();

  // Start simulation loop
  setInterval(tick, UPDATE_INTERVAL_MS);

  // Welcome toast
  setTimeout(() => showToast('🛡 RideGuard online – All sensors active', 'success'), 800);
});
