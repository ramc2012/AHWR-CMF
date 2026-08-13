import React, { useEffect, useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import {
    Box, Paper, TextField, Button, Typography, Alert, ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import { PersonOutline, LockOutlined } from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

const fieldSx = {
    '& .MuiOutlinedInput-root': {
        color: '#fff',
        '& fieldset': { borderColor: '#475569' },
        '&:hover fieldset': { borderColor: '#94a3b8' },
        '&.Mui-focused fieldset': { borderColor: '#34d399' },
    },
    '& .MuiInputLabel-root': { color: '#94a3b8' },
    '& .MuiInputLabel-root.Mui-focused': { color: '#34d399' },
};

// Pure-CSS/SVG animated fleet-network backdrop for the brand panel (no external assets).
const FleetNetwork = () => (
    <Box
        aria-hidden="true"
        sx={{
            position: 'absolute',
            right: { xs: -60, md: -10 },
            bottom: -20,
            width: { xs: 260, md: 380 },
            pointerEvents: 'none',
            opacity: 0.55,
            '& .node-pulse': { animation: 'nodePulse 3.2s ease-in-out infinite' },
            '& .node-pulse-2': { animation: 'nodePulse 3.2s ease-in-out 1.1s infinite' },
            '& .node-pulse-3': { animation: 'nodePulse 3.2s ease-in-out 2.2s infinite' },
            '@keyframes nodePulse': {
                '0%, 100%': { opacity: 0.2 },
                '50%': { opacity: 1 },
            },
        }}
    >
        <svg viewBox="0 0 380 320" width="100%" xmlns="http://www.w3.org/2000/svg">
            <g stroke="#34d399" strokeWidth="1.6" opacity="0.3">
                <path d="M190 170 90 60M190 170 300 52M190 170 330 170M190 170 292 272M190 170 96 260M190 170 44 150" />
                <path d="M90 60 300 52M300 52 330 170M96 260 44 150" />
            </g>
            <g fill="#60a5fa" opacity="0.55">
                <circle cx="90" cy="60" r="7" />
                <circle cx="300" cy="52" r="7" />
                <circle cx="330" cy="170" r="7" />
                <circle cx="292" cy="272" r="7" />
                <circle cx="96" cy="260" r="7" />
                <circle cx="44" cy="150" r="7" />
            </g>
            <circle className="node-pulse" cx="90" cy="60" r="12" fill="none" stroke="#60a5fa" strokeWidth="2" />
            <circle className="node-pulse-2" cx="330" cy="170" r="12" fill="none" stroke="#60a5fa" strokeWidth="2" />
            <circle className="node-pulse-3" cx="96" cy="260" r="12" fill="none" stroke="#60a5fa" strokeWidth="2" />
            <circle cx="190" cy="170" r="13" fill="#0b1220" stroke="#34d399" strokeWidth="4" />
            <circle cx="190" cy="170" r="4.5" fill="#34d399" />
        </svg>
    </Box>
);

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
        <Box
            sx={{
                minHeight: '100vh',
                width: '100%',
                display: 'flex',
                flexDirection: { xs: 'column', md: 'row' },
                bgcolor: '#0b1220',
                color: '#e2e8f0',
            }}
        >
            {/* ---- Brand panel ---- */}
            <Box
                sx={{
                    position: 'relative',
                    overflow: 'hidden',
                    flex: { md: '1 1 55%' },
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    gap: 4,
                    px: { xs: 3, md: 7 },
                    py: { xs: 4, md: 6 },
                    minHeight: { md: '100vh' },
                    background: 'linear-gradient(160deg, #0b1220 0%, #0e2230 55%, #0b1220 100%)',
                    borderRight: { md: '1px solid rgba(148,163,184,0.12)' },
                    borderBottom: { xs: '1px solid rgba(148,163,184,0.12)', md: 'none' },
                }}
            >
                {/* animated ambient glow */}
                <Box
                    aria-hidden="true"
                    sx={{
                        position: 'absolute',
                        inset: 0,
                        pointerEvents: 'none',
                        background:
                            'radial-gradient(620px 420px at 18% 18%, rgba(52,211,153,0.13), transparent 62%),' +
                            'radial-gradient(520px 400px at 85% 92%, rgba(96,165,250,0.12), transparent 60%)',
                        animation: 'fleetGlow 12s ease-in-out infinite alternate',
                        '@keyframes fleetGlow': {
                            from: { opacity: 0.55 },
                            to: { opacity: 1 },
                        },
                    }}
                />
                <FleetNetwork />

                <Box sx={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Box
                        component="img"
                        src="/icons/central-icon.svg"
                        alt="CRMF — Centralised Rig Monitoring Facility"
                        sx={{ width: { xs: 48, md: 60 }, height: { xs: 48, md: 60 }, flexShrink: 0 }}
                    />
                    <Box>
                        <Typography sx={{ fontWeight: 800, letterSpacing: 0.5, color: '#fff', fontSize: { xs: 22, md: 28 }, lineHeight: 1.15 }}>
                            CRMF
                        </Typography>
                        <Typography variant="body2" sx={{ color: '#6ee7b7', letterSpacing: 1.5, textTransform: 'uppercase', fontSize: 12 }}>
                            Centralised Rig Monitoring Facility
                        </Typography>
                    </Box>
                </Box>

                <Box sx={{ position: 'relative', display: { xs: 'none', md: 'block' }, maxWidth: 460 }}>
                    <Typography sx={{ color: '#cbd5e1', fontSize: 20, fontWeight: 600, lineHeight: 1.45 }}>
                        One portal for the whole AHWR fleet — live rig status, alarms and performance across every site.
                    </Typography>
                    <Typography variant="body2" sx={{ color: '#94a3b8', mt: 1 }}>
                        ONGC AHWR Fleet
                    </Typography>
                    <Box sx={{ mt: 2.5, height: 3, width: 76, borderRadius: 2, background: 'linear-gradient(90deg, #34d399, #60a5fa)' }} />
                </Box>

                <Box sx={{ position: 'relative' }}>
                    {/* Official ONGC brand artwork (supplied asset). The logo is
                        designed for a light ground, so it sits on a white card. */}
                    <Box sx={{ display: 'inline-block', bgcolor: '#fff', borderRadius: 2, px: 2, py: 1.25, boxShadow: '0 4px 18px rgba(0,0,0,0.35)' }}>
                        <Box
                            component="img"
                            src="/brand/ongc-logo.png"
                            alt="ONGC — Energy: Now and Next"
                            sx={{ height: { xs: 48, md: 64 }, display: 'block' }}
                        />
                    </Box>
                </Box>
            </Box>

            {/* ---- Sign-in panel ---- */}
            <Box
                sx={{
                    flex: { md: '1 1 45%' },
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    px: { xs: 2.5, md: 6 },
                    py: { xs: 4, md: 6 },
                }}
            >
                <Paper
                    component="form"
                    onSubmit={submit}
                    elevation={24}
                    sx={{
                        width: '100%',
                        maxWidth: 430,
                        p: { xs: 3, md: 4.5 },
                        bgcolor: 'rgba(15, 23, 42, 0.78)',
                        backdropFilter: 'blur(12px)',
                        border: '1px solid rgba(148, 163, 184, 0.16)',
                        borderRadius: 4,
                    }}
                >
                    <Typography variant="h5" sx={{ fontWeight: 800, color: '#fff', letterSpacing: 0.4 }}>
                        Fleet sign in
                    </Typography>
                    <Typography variant="body2" sx={{ color: '#94a3b8', mb: 3, mt: 0.5 }}>
                        ONGC AHWR Fleet · Centralised Rig Monitoring Facility
                    </Typography>

                    <ToggleButtonGroup
                        exclusive
                        fullWidth
                        value={accountMode}
                        onChange={(_, v) => v && setAccountMode(v)}
                        sx={{
                            mb: 2.5,
                            '& .MuiToggleButton-root': { color: '#94a3b8', borderColor: '#475569', textTransform: 'none', py: 0.75 },
                            '& .Mui-selected': { color: '#fff !important', bgcolor: 'rgba(52,211,153,0.18) !important', borderColor: '#34d399 !important' },
                        }}
                    >
                        <ToggleButton value="local">
                            Local account
                        </ToggleButton>
                        <ToggleButton value="domain" disabled={!ldapEnabled}>
                            Windows Domain
                        </ToggleButton>
                    </ToggleButtonGroup>

                    {ldapEnabled && accountMode === 'domain' && (
                        <Typography variant="caption" color="#94a3b8" display="block" textAlign="center" mb={1.5}>
                            {domain ? `Use ${domain} domain credentials` : 'Use your Windows domain credentials'}
                        </Typography>
                    )}
                    {err && <Alert severity="error" sx={{ mb: 2, bgcolor: 'rgba(239, 68, 68, 0.1)', color: '#fca5a5' }}>{err}</Alert>}

                    <TextField
                        fullWidth
                        label="User ID *"
                        value={username}
                        onChange={(e) => setU(e.target.value)}
                        margin="normal"
                        autoFocus
                        autoComplete="username"
                        InputProps={{ startAdornment: <PersonOutline sx={{ mr: 1.25, color: '#94a3b8' }} /> }}
                        sx={fieldSx}
                    />
                    <TextField
                        fullWidth
                        label="Password *"
                        type="password"
                        value={password}
                        onChange={(e) => setP(e.target.value)}
                        margin="normal"
                        autoComplete="current-password"
                        InputProps={{ startAdornment: <LockOutlined sx={{ mr: 1.25, color: '#94a3b8' }} /> }}
                        sx={fieldSx}
                    />
                    <Button
                        type="submit"
                        fullWidth
                        variant="contained"
                        size="large"
                        sx={{
                            mt: 3,
                            py: 1.55,
                            bgcolor: '#34d399',
                            '&:hover': { bgcolor: '#10b981' },
                            color: '#07111f',
                            fontWeight: 900,
                            fontSize: 16,
                        }}
                        disabled={busy}
                    >
                        {busy ? 'SIGNING IN...' : 'SIGN IN'}
                    </Button>

                    <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: '#64748b', mt: 2 }}>
                        © ONGC · Oil and Natural Gas Corporation
                    </Typography>
                </Paper>
            </Box>
        </Box>
    );
}
