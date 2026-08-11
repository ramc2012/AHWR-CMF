import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../api';
import { socket, connectSocket } from '../socket';

// Per-rig live data for the remote HMI mirror. Polls /api/rigs/:id/live (the edge
// `rig_data` shape reconstructed centrally) on an interval and exposes it via a hook,
// so the ported edge operator panels read `data.<measurement>.<field>` unchanged.
// READ-ONLY: this only fetches reshaped telemetry already received from the rig.
const RigDataContext = createContext(null);
export const useRigData = () => useContext(RigDataContext) || { data: null, loading: true, error: '' };

export function RigDataProvider({ rigId, intervalMs = 1000, children }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const alive = useRef(true);
    const refreshTimer = useRef(null);

    const load = useCallback(() => {
        if (!rigId) return;
        api.rigLive(rigId)
            .then((d) => { if (alive.current) { setData(d); setError(''); } })
            .catch((e) => { if (alive.current && e?.response?.status !== 401) setError(e?.response?.data?.error || 'live data unavailable'); })
            .finally(() => { if (alive.current) setLoading(false); });
    }, [rigId]);

    useEffect(() => {
        alive.current = true;
        setLoading(true); load();
        const t = setInterval(load, intervalMs);
        return () => {
            alive.current = false;
            clearInterval(t);
            if (refreshTimer.current) clearTimeout(refreshTimer.current);
        };
    }, [load, intervalMs]);

    useEffect(() => {
        if (!rigId) return undefined;
        connectSocket();
        const onRigLive = (payload) => {
            if (payload?.rigId !== rigId) return;
            if (!alive.current) return;
            setData(payload.data);
            setError('');
            setLoading(false);
        };
        const onFleetUpdate = (row) => {
            const updateRigId = row?.rigId || row?.rig_id;
            if (updateRigId !== rigId) return;
            if (refreshTimer.current) return;
            refreshTimer.current = setTimeout(() => {
                refreshTimer.current = null;
                load();
            }, 120);
        };
        socket.on('rig_live', onRigLive);
        socket.on('fleet_update', onFleetUpdate);
        return () => {
            socket.off('rig_live', onRigLive);
            socket.off('fleet_update', onFleetUpdate);
        };
    }, [rigId, load]);

    return (
        <RigDataContext.Provider value={{ data, loading, error, rigId, refresh: load }}>
            {children}
        </RigDataContext.Provider>
    );
}


