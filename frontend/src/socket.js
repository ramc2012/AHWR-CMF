import { io } from 'socket.io-client';

// One shared socket; auth token read fresh on every (re)connect.
export const socket = io('/', {
    autoConnect: false,
    auth: (cb) => cb({ token: localStorage.getItem('crmf_token') }),
});

export const connectSocket = () => { if (!socket.connected) socket.connect(); };
export const disconnectSocket = () => { if (socket.connected) socket.disconnect(); };
