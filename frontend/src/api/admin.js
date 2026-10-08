import api from './axios';

export const getDashboardStats = () => api.get('/admin/dashboard');

export const getAdminUsers = (params) => api.get('/admin/users', { params });
export const updateUserStatus = (id, status) => api.patch(`/admin/users/${id}/status`, { status });
// Emergency desk (responder) access. The only way it is granted; audited server-side.
export const setResponderAccess = (id, approved) => api.patch(`/admin/users/${id}/responder`, { approved });

export const getAdminReports = (params) => api.get('/admin/reports', { params });
export const removeReport = (id) => api.delete(`/admin/reports/${id}`);

export const getBusinesses = (params) => api.get('/admin/businesses', { params });
export const addBusiness = (data) => api.post('/admin/businesses', data);
export const updateBusiness = (id, data) => api.patch(`/admin/businesses/${id}`, data);

export const getBroadcasts = () => api.get('/admin/broadcasts');
export const createBroadcast = (data) => api.post('/admin/broadcasts', data);
export const deleteBroadcast = (id) => api.delete(`/admin/broadcasts/${id}`);

export const getPartners = (params) => api.get('/admin/partners', { params });
export const addPartner = (data) => api.post('/admin/partners', data);
export const updatePartnerStatus = (id, status) => api.patch(`/admin/partners/${id}/status`, { status });

export const getSponsorships = (params) => api.get('/admin/sponsorships', { params });
export const updateSponsorship = (id, data) => api.patch(`/admin/sponsorships/${id}`, data);

export const getPayouts = (params) => api.get('/admin/payouts', { params });
export const updatePayout = (id, data) => api.patch(`/admin/payouts/${id}`, data);
