import api from './axios';

export const getProfile = () => api.get('/user/profile');
export const updateProfile = (data) => api.put('/user/profile', data);
export const getPreferences = () => api.get('/user/preferences');
export const updatePreferences = (data) => api.put('/user/preferences', data);
