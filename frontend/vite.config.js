import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy points at the local backend; in the container nginx does the proxying.
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:6000',
            '/socket.io': { target: 'http://localhost:6000', ws: true },
        },
    },
});
