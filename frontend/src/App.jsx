import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './components/Login';
import FleetOverview from './components/FleetOverview';
import RigDetail from './components/RigDetail';
import Wells from './components/Wells';
import WellDetail from './components/WellDetail';
import AlarmCommandCentre from './components/AlarmCommandCentre';
import DataQuality from './components/DataQuality';
import WorkoverPerformance from './components/WorkoverPerformance';
import Governance from './components/Governance';
import Reports from './components/Reports';
import ConfigRegistry from './components/ConfigRegistry';
import Maintenance from './components/Maintenance';
import Users from './components/Users';
import Settings from './components/Settings';

function Protected({ children }) {
    const { user } = useAuth();
    if (!user) return <Navigate to="/login" replace />;
    return children;
}

// Role-gated route wrapper: redirect to the fleet overview if the user lacks the role.
function RequireRole({ role, children }) {
    const { can } = useAuth();
    if (!can(role)) return <Navigate to="/" replace />;
    return children;
}

export default function App() {
    return (
        <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Protected><Layout /></Protected>}>
                <Route index element={<FleetOverview />} />
                <Route path="rigs/:id" element={<RigDetail />} />
                <Route path="wells" element={<Wells />} />
                <Route path="wells/:id" element={<WellDetail />} />
                <Route path="alarms" element={<AlarmCommandCentre />} />
                <Route path="data-quality" element={<DataQuality />} />
                <Route path="workover" element={<WorkoverPerformance />} />
                <Route path="maintenance" element={<Maintenance />} />
                <Route path="governance" element={<Governance />} />
                <Route path="reports" element={<Reports />} />
                <Route path="registry" element={<ConfigRegistry />} />
                <Route path="users" element={<RequireRole role="admin"><Users /></RequireRole>} />
                <Route path="settings" element={<RequireRole role="admin"><Settings /></RequireRole>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}
