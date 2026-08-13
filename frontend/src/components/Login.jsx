import React, { useEffect, useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import {
    Box, Paper, TextField, Button, Typography, Alert, ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import { PersonOutline, LockOutlined } from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { OngcLockupCard, Ongc70Tagline, RigPhotoBackdrop } from './Brand/OngcBrand';

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
                {/* AHWR rig aerial photograph backdrop (official site photo) */}
                <RigPhotoBackdrop />

                <Box sx={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Box
                        component="img"
                        src="/icons/central-icon.svg"
                        alt="CRMF — Centralised Rig Monitoring Facility"
                        sx={{ width: { xs: 48, md: 60 }, height: { xs: 48, md: 60 }, flexShrink: 0 }}
                    />
                    <Box>
                        <Typography sx={{ fontWeight: 800, letterSpacing: 0.5, color: '#fff', fontSize: { xs: 22, md: 28 }, lineHeight: 1.15, fontFamily: 'Mukta, sans-serif' }}>
                            CRMF
                        </Typography>
                        <Typography variant="body2" sx={{ color: '#6ee7b7', letterSpacing: 1.5, textTransform: 'uppercase', fontSize: 12 }}>
                            Centralised Rig Monitoring Facility
                        </Typography>
                    </Box>
                </Box>

                <Box sx={{ position: 'relative', display: { xs: 'none', md: 'block' }, maxWidth: 460 }}>
                    <Typography sx={{ color: '#e2e8f0', fontSize: 20, fontWeight: 600, lineHeight: 1.45, textShadow: '0 2px 10px rgba(0,0,0,0.6)' }}>
                        One portal for the whole AHWR fleet — live rig status, alarms and performance across every site.
                    </Typography>
                    <Typography variant="body2" sx={{ color: '#94a3b8', mt: 1 }}>
                        ONGC AHWR Fleet
                    </Typography>
                    <Box sx={{ mt: 2.5, height: 3, width: 76, borderRadius: 2, background: 'linear-gradient(90deg, #34d399, #60a5fa)' }} />
                </Box>

                <Box sx={{ position: 'relative' }}>
                    {/* Official ONGC lockup artwork, grafted as-is on a white card. */}
                    <OngcLockupCard height={86} />
                    <Ongc70Tagline sx={{ mt: 2, display: 'flex' }} />
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
