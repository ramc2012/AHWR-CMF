import React from 'react';
import { Box, Paper, Typography, Button, Stack } from '@mui/material';
import { ReportProblem, Refresh } from '@mui/icons-material';

// Global / per-panel error boundary (audit #12). A render-time throw in any wrapped
// subtree (a malformed/unexpected API payload, recharts on a bad value, a null where an
// array is assumed) is caught here and rendered as a 'panel failed to load — retry' fallback
// instead of unmounting the whole React tree and blanking the 24/7 monitoring wall.
export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        // Log to the console for the operator/dev tools; never crash on logging itself.
        // eslint-disable-next-line no-console
        console.error('[CRMF ErrorBoundary]', this.props.label || 'panel', error, info?.componentStack);
    }

    reset = () => this.setState({ error: null });

    render() {
        if (this.state.error) {
            const label = this.props.label || 'This panel';
            return (
                <Box sx={{ p: this.props.compact ? 1 : 3 }}>
                    <Paper sx={{ p: this.props.compact ? 2 : 3, borderColor: 'error.main' }}>
                        <Stack direction="row" spacing={1.5} alignItems="flex-start">
                            <ReportProblem color="error" />
                            <Box sx={{ flexGrow: 1 }}>
                                <Typography variant="subtitle1" fontWeight={800} color="error.main">
                                    {label} failed to load
                                </Typography>
                                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                                    An unexpected error occurred while rendering this view. The rest of the
                                    monitoring console is unaffected. You can retry — if it persists, reload the page.
                                </Typography>
                                {this.state.error?.message && (
                                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block', fontFamily: 'monospace' }}>
                                        {String(this.state.error.message)}
                                    </Typography>
                                )}
                                <Button size="small" variant="outlined" startIcon={<Refresh />} onClick={this.reset} sx={{ mt: 1.5 }}>
                                    Retry
                                </Button>
                            </Box>
                        </Stack>
                    </Paper>
                </Box>
            );
        }
        return this.props.children;
    }
}
