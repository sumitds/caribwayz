import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/Layout/ProtectedRoute';

import Login from './pages/auth/Login';
import Register from './pages/auth/Register';
import ForgotPassword from './pages/auth/ForgotPassword';

// User pages
import Dashboard from './pages/Dashboard';
import RoutesList from './pages/Routes/RoutesList';
import RouteDetail from './pages/Routes/RouteDetail';
import ReportsList from './pages/Reports/ReportsList';
import EmergencyPage from './pages/Emergency/EmergencyPage';
import EmergencyDesk from './pages/Desk/EmergencyDesk';
import GroupsList from './pages/Groups/GroupsList';
import GroupDetail from './pages/Groups/GroupDetail';
import NotificationsPage from './pages/Notifications/NotificationsPage';
import ProfilePage from './pages/Profile/ProfilePage';
import RecordsList from './pages/Record/RecordsList';
import RecordCreate from './pages/Record/RecordCreate';
import RecordDetail from './pages/Record/RecordDetail';

// Admin pages
import AdminDashboard from './pages/Admin/AdminDashboard';
import AdminUsers from './pages/Admin/AdminUsers';
import AdminReports from './pages/Admin/AdminReports';
import AdminBusinesses from './pages/Admin/AdminBusinesses';
import AdminBroadcast from './pages/Admin/AdminBroadcast';
import AdminPartners from './pages/Admin/AdminPartners';
import AdminSponsorships from './pages/Admin/AdminSponsorships';
import AdminPayouts from './pages/Admin/AdminPayouts';

const App = () => (
  <AuthProvider>
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />

      {/* User routes */}
      <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/routes" element={<ProtectedRoute><RoutesList /></ProtectedRoute>} />
      <Route path="/routes/:id" element={<ProtectedRoute><RouteDetail /></ProtectedRoute>} />
      <Route path="/reports" element={<ProtectedRoute><ReportsList /></ProtectedRoute>} />
      <Route path="/emergency" element={<ProtectedRoute><EmergencyPage /></ProtectedRoute>} />
      {/* Responders and admins; the API refuses anyone else and the page says so. */}
      <Route path="/desk" element={<ProtectedRoute><EmergencyDesk /></ProtectedRoute>} />
      <Route path="/groups" element={<ProtectedRoute><GroupsList /></ProtectedRoute>} />
      <Route path="/groups/:id" element={<ProtectedRoute><GroupDetail /></ProtectedRoute>} />
      <Route path="/notifications" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />
      <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
      <Route path="/record" element={<ProtectedRoute><RecordsList /></ProtectedRoute>} />
      <Route path="/record/new" element={<ProtectedRoute><RecordCreate /></ProtectedRoute>} />
      <Route path="/record/:id" element={<ProtectedRoute><RecordDetail /></ProtectedRoute>} />

      {/* Admin-only routes */}
      <Route path="/admin" element={<ProtectedRoute adminOnly><AdminDashboard /></ProtectedRoute>} />
      <Route path="/admin/broadcast" element={<ProtectedRoute adminOnly><AdminBroadcast /></ProtectedRoute>} />
      <Route path="/admin/users" element={<ProtectedRoute adminOnly><AdminUsers /></ProtectedRoute>} />
      <Route path="/admin/reports" element={<ProtectedRoute adminOnly><AdminReports /></ProtectedRoute>} />
      <Route path="/admin/businesses" element={<ProtectedRoute adminOnly><AdminBusinesses /></ProtectedRoute>} />
      <Route path="/admin/partners" element={<ProtectedRoute adminOnly><AdminPartners /></ProtectedRoute>} />
      <Route path="/admin/sponsorships" element={<ProtectedRoute adminOnly><AdminSponsorships /></ProtectedRoute>} />
      <Route path="/admin/payouts" element={<ProtectedRoute adminOnly><AdminPayouts /></ProtectedRoute>} />

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  </AuthProvider>
);

export default App;
