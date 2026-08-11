import React, { createContext, useContext, useState, useCallback } from 'react';
import { api, setToken } from '../api';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(() => {
        try { return JSON.parse(localStorage.getItem('crmf_user') || 'null'); } catch { return null; }
    });

    const login = useCallback(async (username, password) => {
        const { token, user } = await api.login(username, password);
        setToken(token);
        localStorage.setItem('crmf_user', JSON.stringify(user));
        setUser(user);
        return user;
    }, []);

    const logout = useCallback(() => {
        setToken(null);
        localStorage.removeItem('crmf_user');
        setUser(null);
    }, []);

    const can = useCallback((role) => {
        const rank = { viewer: 1, operator: 2, admin: 3 };
        return (rank[user?.role] || 0) >= (rank[role] || 99);
    }, [user]);

    return (
        <AuthContext.Provider value={{ user, login, logout, can }}>
            {children}
        </AuthContext.Provider>
    );
}
