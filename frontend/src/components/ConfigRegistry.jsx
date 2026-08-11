import React, { useEffect, useState } from 'react';
import {
    Box, Paper, Typography, Grid, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Tabs, Tab, Chip, Alert,
} from '@mui/material';
import { api } from '../api';

export default function ConfigRegistry() {
    const [tab, setTab] = useState(0);
    const [tags, setTags] = useState([]);
    const [rigs, setRigs] = useState([]);
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setErr(''); setLoading(true);
        const fail = (e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load configuration registry'); };
        Promise.all([
            api.tags().then((d) => setTags(Array.isArray(d) ? d : [])).catch(fail),
            api.rigsConfig().then((d) => setRigs(Array.isArray(d) ? d : [])).catch(fail),
        ]).finally(() => setLoading(false));
    }, []);

    // Group tags by equipment group for the dictionary view.
    const groups = tags.reduce((acc, t) => { (acc[t.group] = acc[t.group] || []).push(t); return acc; }, {});

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Typography variant="h5" fontWeight={800} mb={2}>Configuration Registry</Typography>
            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}
            <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ borderBottom: '1px solid rgba(255,255,255,0.06)', flex: '0 0 auto' }}>
                    <Tab label={`Standard tag dictionary (${tags.length})`} />
                    <Tab label={`Rig master (${rigs.length})`} />
                </Tabs>

                {tab === 0 && (
                    <Box sx={{ p: 2, flex: 1, minHeight: 0, overflow: 'auto' }}>
                        <Typography variant="caption" color="text.secondary">
                            Single source of truth for the 100-channel standard tag set (proposal §4.4, §6.1). Expected tags count toward each rig's data-completeness score.
                        </Typography>
                        <Grid container spacing={2} mt={0.5}>
                            {!tags.length && (
                                <Grid item xs={12}><Typography color="text.secondary" sx={{ py: 3 }} align="center">{loading ? 'Loading tag dictionary…' : 'No tags configured.'}</Typography></Grid>
                            )}
                            {Object.entries(groups).map(([group, items]) => (
                                <Grid item xs={12} md={6} key={group}>
                                    <Typography variant="subtitle2" color="primary" gutterBottom>{group}</Typography>
                                    <Table size="small">
                                        <TableHead><TableRow>
                                            <TableCell>Tag</TableCell><TableCell>Metric</TableCell>
                                            <TableCell>Unit</TableCell><TableCell align="center">Expected</TableCell>
                                        </TableRow></TableHead>
                                        <TableBody>
                                            {items.map((t) => (
                                                <TableRow key={t.metric}>
                                                    <TableCell>{t.label}</TableCell>
                                                    <TableCell><Typography variant="caption" color="text.secondary" fontFamily="monospace">{t.metric}</Typography></TableCell>
                                                    <TableCell>{t.unit || '—'}</TableCell>
                                                    <TableCell align="center">{t.expected ? <Chip size="small" color="success" variant="outlined" label="yes" /> : <Chip size="small" variant="outlined" label="no" />}</TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </Grid>
                            ))}
                        </Grid>
                    </Box>
                )}

                {tab === 1 && (
                    <TableContainer sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                        <Table size="small" stickyHeader>
                            <TableHead><TableRow>
                                <TableCell>Rig ID</TableCell><TableCell>Name</TableCell><TableCell>Section</TableCell>
                                <TableCell>Field</TableCell><TableCell align="right">Latitude</TableCell><TableCell align="right">Longitude</TableCell>
                                <TableCell>Schema</TableCell><TableCell>Commissioned</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                                {rigs.map((r) => (
                                    <TableRow key={r.rig_id} hover>
                                        <TableCell><Typography variant="caption" fontFamily="monospace">{r.rig_id}</Typography></TableCell>
                                        <TableCell><Typography variant="body2" fontWeight={700}>{r.name}</Typography></TableCell>
                                        <TableCell>{r.section || '—'}</TableCell>
                                        <TableCell>{r.field || '—'}</TableCell>
                                        <TableCell align="right">{r.latitude?.toFixed?.(4) ?? '—'}</TableCell>
                                        <TableCell align="right">{r.longitude?.toFixed?.(4) ?? '—'}</TableCell>
                                        <TableCell>{r.schema_version || '—'}</TableCell>
                                        <TableCell>{r.commissioned_at ? new Date(r.commissioned_at).toLocaleDateString() : '—'}</TableCell>
                                    </TableRow>
                                ))}
                                {!rigs.length && (
                                    <TableRow><TableCell colSpan={8} align="center" sx={{ py: 5, color: 'text.secondary' }}>{loading ? 'Loading rig master…' : 'No rigs configured.'}</TableCell></TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </TableContainer>
                )}
            </Paper>
        </Box>
    );
}
