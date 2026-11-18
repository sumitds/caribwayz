import api from './axios';

export const triggerEmergency = (data) => api.post('/emergency', data);
export const getEmergencyStatus = (id) => api.get(`/emergency/${id}`);

// The person who raised an alert cancels it (desk status Cancelled).
export const cancelEmergency = (id) => api.post(`/emergency/${id}/cancel`);

// The emergency desk (responders and admins). The feed's status filter is
// 'active' (Pending and Acknowledged) or 'closed' (admins only); each alert's
// desk_status is pending | acknowledged | addressed | cancelled | resolved.
export const listEmergencies = (params) => api.get('/emergency', { params });
export const acknowledgeEmergency = (id) => api.post(`/emergency/${id}/acknowledge`);
export const releaseEmergency = (id) => api.post(`/emergency/${id}/release`);
export const addressEmergency = (id) => api.post(`/emergency/${id}/address`);
