import axios from 'axios';

// Same-origin: nginx proxies /api and /socket.io to the CRMF backend.
axios.defaults.baseURL = '';

const stored = localStorage.getItem('crmf_token');
if (stored) axios.defaults.headers.common['Authorization'] = 'Bearer ' + stored;

let handling401 = false;
axios.interceptors.response.use(
    (r) => r,
    (error) => {
        if (error?.response?.status === 401 && !handling401) {
            handling401 = true;
            localStorage.removeItem('crmf_token');
            localStorage.removeItem('crmf_user');
            delete axios.defaults.headers.common['Authorization'];
            if (window.location.pathname !== '/login') window.location.assign('/login');
            else handling401 = false;
        }
        return Promise.reject(error);
    }
);

// Activity-phase colour key (matches the edge ActivityPage + CRMF spec). Productive
// phases get their own hue; any NPT / wait / idle / stop maps to red; unknown -> grey.
const PHASE_COLORS = {
    RIH: '#38bdf8', POOH: '#22d3ee', CIRCULATE: '#4ade80', MAKE_UP: '#fbbf24',
    BREAK_OUT: '#a78bfa', TRIP: '#38bdf8', DRILL: '#4ade80', RUN: '#38bdf8', PULL: '#22d3ee',
    WAIT: '#ef4444', IDLE: '#ef4444', NPT: '#ef4444', REPAIR: '#ef4444', STOP: '#ef4444',
};
export const phaseColor = (phase) => PHASE_COLORS[String(phase || '').toUpperCase()] || '#64748b';

export const setToken = (token) => {
    if (token) {
        localStorage.setItem('crmf_token', token);
        axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
    } else {
        localStorage.removeItem('crmf_token');
        delete axios.defaults.headers.common['Authorization'];
    }
};

export const api = {
    authInfo: () => axios.get('/api/auth/info').then((r) => r.data),
    login: (username, password) => axios.post('/api/auth/login', { username, password }).then((r) => r.data),
    me: () => axios.get('/api/auth/me').then((r) => r.data),
    fleet: () => axios.get('/api/fleet').then((r) => r.data),
    summary: () => axios.get('/api/fleet/summary').then((r) => r.data),
    rig: (id) => axios.get(`/api/rigs/${id}`).then((r) => r.data),
    history: (id, metric, minutes) => axios.get(`/api/rigs/${id}/history`, { params: { metric, minutes } }).then((r) => r.data),
    // Per-rig activity timeline (current phase + ordered segments + per-phase aggregate + productive/NPT totals).
    activity: (id, hours) => axios.get(`/api/rigs/${id}/activity`, { params: hours ? { hours } : {} }).then((r) => r.data),
    // Per-rig remote HMI mirror (edge-shape live payload + multi-metric strips + alarms).
    rigLive: (id) => axios.get(`/api/rigs/${id}/live`).then((r) => r.data),
    rigHistoryMulti: (id, metrics, minutes, maxPoints) => axios.get(`/api/rigs/${id}/history-multi`, { params: { metrics: Array.isArray(metrics) ? metrics.join(',') : metrics, minutes, maxPoints } }).then((r) => r.data),
    rigAlarms: (id, limit) => axios.get(`/api/rigs/${id}/alarms`, { params: { limit } }).then((r) => r.data),
    allRigMessages: (limit) => axios.get('/api/messages', { params: { limit } }).then((r) => r.data),
    rigCmms: (id) => axios.get(`/api/rigs/${id}/cmms`).then((r) => r.data),
    rigMessages: (id, limit) => axios.get(`/api/rigs/${id}/messages`, { params: { limit } }).then((r) => r.data),
    sendRigMessage: (id, body) => axios.post(`/api/rigs/${id}/messages`, body).then((r) => r.data),
    retryRigMessage: (id, messageId) => axios.post(`/api/rigs/${id}/messages/${messageId}/retry`).then((r) => r.data),
    alarms: (priority) => axios.get('/api/alarms', { params: { priority } }).then((r) => r.data),
    dataQuality: () => axios.get('/api/data-quality').then((r) => r.data),
    workover: (hours) => axios.get('/api/workover', { params: { hours } }).then((r) => r.data),
    governance: () => axios.get('/api/governance').then((r) => r.data),
    updateDeployment: (rigId, patch) => axios.patch(`/api/governance/deployment/${rigId}`, patch).then((r) => r.data),
    addEscalation: (body) => axios.post('/api/governance/escalations', body).then((r) => r.data),
    updateEscalation: (id, patch) => axios.patch(`/api/governance/escalations/${id}`, patch).then((r) => r.data),
    addDecision: (body) => axios.post('/api/governance/decisions', body).then((r) => r.data),
    tags: () => axios.get('/api/config/tags').then((r) => r.data),
    rigsConfig: () => axios.get('/api/config/rigs').then((r) => r.data),
    // Reporting periods (audit #29): snapshot (default, current behaviour) | daily | weekly | monthly.
    report: (period) => axios.get('/api/reports/fleet', { params: period ? { period } : {} }).then((r) => r.data),

    // Maintenance & Reliability (audit #7).
    maintenance: (params) => axios.get('/api/maintenance', { params }).then((r) => r.data),
    maintenanceSummary: () => axios.get('/api/maintenance/summary').then((r) => r.data),
    maintenanceFleetDaily: () => axios.get('/api/maintenance/fleet-daily').then((r) => r.data),
    addMaintenance: (body) => axios.post('/api/maintenance', body).then((r) => r.data),
    updateMaintenance: (id, patch) => axios.patch(`/api/maintenance/${id}`, patch).then((r) => r.data),

    // User & Access Management (audit #8) — admin-only on the backend.
    users: () => axios.get('/api/users').then((r) => r.data),
    addUser: (body) => axios.post('/api/users', body).then((r) => r.data),
    updateUser: (username, patch) => axios.patch(`/api/users/${username}`, patch).then((r) => r.data),
    deleteUser: (username) => axios.delete(`/api/users/${username}`).then((r) => r.data),

    // Alarm notifications (webhook/email). Channels are admin-only on the backend.
    notifications: (limit) => axios.get('/api/notifications', { params: { limit } }).then((r) => r.data),
    notifyChannels: () => axios.get('/api/notifications/channels').then((r) => r.data),
    addNotifyChannel: (body) => axios.post('/api/notifications/channels', body).then((r) => r.data),
    updateNotifyChannel: (id, patch) => axios.patch(`/api/notifications/channels/${id}`, patch).then((r) => r.data),
    deleteNotifyChannel: (id) => axios.delete(`/api/notifications/channels/${id}`).then((r) => r.data),
    testNotifyChannel: (id) => axios.post(`/api/notifications/channels/${id}/test`).then((r) => r.data),

    // Central settings (retention/update-rate/offline/latency) — PATCH is admin-only on the backend.
    settings: () => axios.get('/api/settings').then((r) => r.data),
    networkUrls: () => axios.get('/api/network/urls').then((r) => r.data),
    setSettings: (patch) => axios.patch('/api/settings', patch).then((r) => r.data),
    etp20Status: () => axios.get('/api/integrations/etp20/status').then((r) => r.data),
    etp20Connect: () => axios.post('/api/integrations/etp20/connect').then((r) => r.data),
    etp20Disconnect: () => axios.post('/api/integrations/etp20/disconnect').then((r) => r.data),
    etp20Test: (body) => axios.post('/api/integrations/etp20/test', body || {}).then((r) => r.data),

    // Rig registry mutations — admin-only on the backend (monitoring-only: no write path to the rig PLC).
    // addRig returns the created rig plus a one-time `device_token` (the per-rig edge sync credential,
    // generated server-side if the admin left it blank). rotateRigToken issues a fresh token (shown once).
    addRig: (body) => axios.post('/api/rigs', body).then((r) => r.data),
    rotateRigToken: (rigId) => axios.post(`/api/rigs/${encodeURIComponent(rigId)}/rotate-token`).then((r) => r.data),
    deleteRig: (rigId) => axios.delete(`/api/rigs/${rigId}`).then((r) => r.data),

    // User presence / liveness.
    presence: () => axios.get('/api/presence').then((r) => r.data),
    pingPresence: () => axios.post('/api/presence/ping').then((r) => r.data),

    // Wells lifecycle registry (well = first-class lifecycle entity; well_runs link telemetry
    // to a well over a time window for offline EDR replay). List/detail visible to all users;
    // add/update/delete are admin-only on the backend (audited). Monitoring-only throughout.
    // Well ids can contain '#' (e.g. GS-11#4) — a URL fragment delimiter — so they
    // MUST be encodeURIComponent'd in the path or the server sees a truncated id.
    wells: (params) => axios.get('/api/wells', { params }).then((r) => r.data),
    well: (id) => axios.get(`/api/wells/${encodeURIComponent(id)}`).then((r) => r.data),
    wellRuns: (id) => axios.get(`/api/wells/${encodeURIComponent(id)}/runs`).then((r) => r.data),
    addWell: (b) => axios.post('/api/wells', b).then((r) => r.data),
    updateWell: (id, p) => axios.patch(`/api/wells/${encodeURIComponent(id)}`, p).then((r) => r.data),
    deleteWell: (id) => axios.delete(`/api/wells/${encodeURIComponent(id)}`).then((r) => r.data),
    // Range-mode multi-metric history (epochMs from/to) for offline EDR replay over a well run.
    rigHistoryRange: (id, metrics, fromMs, toMs, maxPoints) => axios.get(`/api/rigs/${id}/history-multi`, { params: { metrics: (metrics || []).join(','), from: fromMs, to: toMs, maxPoints } }).then((r) => r.data),
};

