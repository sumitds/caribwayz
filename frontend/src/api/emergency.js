import api from './axios';

export const triggerEmergency = (data) => api.post('/emergency', data);
export const getEmergencyStatus = (id) => api.get(`/emergency/${id}`);
export const resolveEmergency = (id) => api.post(`/emergency/${id}/resolve`);
