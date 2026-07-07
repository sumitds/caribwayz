import api from './axios';

export const getNotifications = (params) => api.get('/notifications', { params });
export const markAsRead = (notification_ids) => api.post('/notifications/read', { notification_ids });
