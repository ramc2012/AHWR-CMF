import React from 'react';
import { Box, Typography } from '@mui/material';

// ONGC brand marks — official artwork grafted as-is (no redrawn logos).
//   /brand/ongc-lockup.png : full lockup (logo block | ONGC wordmark + tagline)
//   /brand/ongc-block.png  : the brown logo block alone (for in-app pages)
//   /brand/rig-aerial.jpg  : AHWR rig aerial photograph (login backdrop)
// Accent colour sampled from the logo block artwork itself.
export const ONGC_BROWN = '#7D3B38';

// The brown ONGC logo block — use on in-app pages (headers etc.).
export const OngcBlockLogo = ({ size = 36, sx }) => (
    <Box
        component="img"
        src="/brand/ongc-block.png"
        alt="ONGC"
        sx={{ width: size, height: size, display: 'block', flexShrink: 0, borderRadius: '6%', ...sx }}
    />
);

// The full ONGC lockup for the front (login) page, on a white card since the
// artwork is designed for a light ground.
export const OngcLockupCard = ({ height = 86, sx }) => (
    <Box
        sx={{
            display: 'inline-block',
            bgcolor: '#fff',
            borderRadius: 2,
            px: 2,
            py: 1.25,
            boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
            ...sx,
        }}
    >
        <Box
            component="img"
            src="/brand/ongc-lockup.png"
            alt="ONGC — Energy: Now and Next"
            sx={{ height, display: 'block', maxWidth: '100%', objectFit: 'contain' }}
        />
    </Box>
);

// "70 years in Energy Exploration" — anniversary tagline. The "70" is the
// official ONGC 70-years mark, grafted as-is (background lifted only).
export const Ongc70Tagline = ({ color = '#f3e9d2', fontSize = 22, markHeight = 56, sx }) => (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.5, ...sx }}>
        <Box
            component="img"
            src="/brand/ongc-70.png"
            alt="70"
            sx={{ height: markHeight, width: 'auto', display: 'block', flexShrink: 0, filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.45))' }}
        />
        <Typography
            component="span"
            sx={{
                color,
                fontFamily: "Georgia, 'Times New Roman', serif",
                fontStyle: 'italic',
                fontSize,
                letterSpacing: 0.4,
                lineHeight: 1.2,
                textShadow: '0 2px 10px rgba(0,0,0,0.45)',
            }}
        >
            years in Energy Exploration
        </Typography>
    </Box>
);

// Full-bleed AHWR rig aerial photograph with a dark gradient overlay, for use
// as the login brand-panel backdrop (keeps foreground text legible).
export const RigPhotoBackdrop = ({ overlay = 'linear-gradient(160deg, rgba(7,13,24,0.92) 0%, rgba(7,13,24,0.55) 45%, rgba(7,13,24,0.82) 100%)' }) => (
    <Box aria-hidden="true" sx={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <Box
            component="img"
            src="/brand/rig-aerial.jpg"
            alt=""
            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        <Box sx={{ position: 'absolute', inset: 0, background: overlay }} />
    </Box>
);

export default OngcBlockLogo;
