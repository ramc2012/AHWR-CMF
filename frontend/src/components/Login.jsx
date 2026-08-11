import React, { useEffect, useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import {
    Box, Paper, TextField, Button, Typography, Alert, Stack, ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import { PersonOutline, LockOutlined, ShowChart } from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

export default function Login() {
    const { user, login } = useAuth();
    const nav = useNavigate();
    const [username, setU] = useState('');
    const [password, setP] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const [info, setInfo] = useState(null);
    const [accountMode, setAccountMode] = useState('local');

    useEffect(() => {
        let alive = true;
        api.authInfo()
            .then((i) => { if (alive) setInfo(i); })
            .catch(() => { if (alive) setInfo(null); });
        return () => { alive = false; };
    }, []);

    if (user) return <Navigate to="/" replace />;

    const submit = async (e) => {
        e.preventDefault();
        setErr('');
        setBusy(true);
        try {
            await login(username, password);
            nav('/');
        } catch {
            setErr('Invalid credentials');
        } finally {
            setBusy(false);
        }
    };

    const ldapEnabled = !!info?.ldapEnabled;
    const domain = info?.domain || null;

    return (
        <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', bgcolor: '#111b2b' }}>
            <Paper
                component="form"
                onSubmit={submit}
                sx={{
                    width: 495,
                    maxWidth: '92vw',
                    px: 5,
                    py: 4.5,
                    borderRadius: 3,
                    bgcolor: '#465260',
                    border: '1px solid rgba(148,163,184,.22)',
                    boxShadow: '0 18px 50px rgba(0,0,0,.32)',
                }}
            >
                <Stack spacing={1.1} alignItems="center" mb={3}>
                    <ShowChart sx={{ color: '#38bdf8', fontSize: 58 }} />
                    <Typography sx={{ color: '#fff', fontSize: { xs: 34, sm: 42 }, lineHeight: 1.1, fontWeight: 900, letterSpacing: 0, textAlign: 'center' }}>
                        AHWR DIGITAL TWIN
                    </Typography>
                    <Typography sx={{ color: '#b6c3d4', fontSize: 18, fontWeight: 700 }}>Digital Twin Access</Typography>
                </Stack>

                <ToggleButtonGroup
                    exclusive
                    fullWidth
                    value={accountMode}
                    onChange={(_, v) => v && setAccountMode(v)}
                    sx={{ mb: 2.5 }}
                >
                    <ToggleButton value="local" sx={{ color: '#dbeafe', borderColor: 'rgba(56,189,248,.55)', '&.Mui-selected': { bgcolor: 'rgba(56,189,248,.28)', color: '#fff' } }}>
                        Local account
                    </ToggleButton>
                    <ToggleButton value="domain" disabled={!ldapEnabled} sx={{ color: '#b6c3d4', borderColor: 'rgba(148,163,184,.24)', '&.Mui-selected': { bgcolor: 'rgba(56,189,248,.28)', color: '#fff' } }}>
                        Windows Domain
                    </ToggleButton>
                </ToggleButtonGroup>

                {ldapEnabled && accountMode === 'domain' && (
                    <Typography variant="caption" color="#b6c3d4" display="block" textAlign="center" mb={1.5}>
                        {domain ? `Use ${domain} domain credentials` : 'Use your Windows domain credentials'}
                    </Typography>
                )}
                {err && <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>}

                <TextField
                    fullWidth
                    label="User ID *"
                    value={username}
                    onChange={(e) => setU(e.target.value)}
                    margin="normal"
                    autoFocus
                    autoComplete="username"
                    InputProps={{ startAdornment: <PersonOutline sx={{ mr: 1.25, color: '#aab6c7' }} /> }}
                    sx={{ '& .MuiOutlinedInput-root': { bgcolor: '#465260' }, '& .MuiInputLabel-root': { color: '#38bdf8' } }}
                />
                <TextField
                    fullWidth
                    label="Password *"
                    type="password"
                    value={password}
                    onChange={(e) => setP(e.target.value)}
                    margin="normal"
                    autoComplete="current-password"
                    InputProps={{ startAdornment: <LockOutlined sx={{ mr: 1.25, color: '#aab6c7' }} /> }}
                    sx={{ '& .MuiOutlinedInput-root': { bgcolor: '#465260' }, '& .MuiInputLabel-root': { color: '#aab6c7' } }}
                />
                <Button type="submit" fullWidth variant="contained" size="large" sx={{ mt: 3, py: 1.55, color: '#07111f', fontWeight: 900, fontSize: 16 }} disabled={busy}>
                    {busy ? 'SIGNING IN...' : 'SIGN IN'}
                </Button>
            </Paper>
        </Box>
    );
}
