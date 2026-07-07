import api from './axios';

export const submitReport = (data) => api.post('/reports', data);
export const getNearbyReports = (params) => api.get('/reports/nearby', { params });
export const confirmReport = (id) => api.post(`/reports/${id}/confirm`);
