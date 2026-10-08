import api from './axios';

export const triggerEmergency = (data) => api.post('/emergency', data);
export const getEmergencyStatus = (id) => api.get(`/emergency/${id}`);
export const resolveEmergency = (id) => api.post(`/emergency/${id}/resolve`);

// The emergency desk (responders and admins). status: 'active' | 'resolved'.
export const listEmergencies = (params) => api.get('/emergency', { params });
export const acknowledgeEmergency = (id) => api.post(`/emergency/${id}/acknowledge`);
export const releaseEmergency = (id) => api.post(`/emergency/${id}/release`);
