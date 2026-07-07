import api from './axios';

export const createGroup = (data) => api.post('/groups', data);
export const joinGroup = (join_code) => api.post('/groups/join', { join_code });
export const getGroupDetails = (id) => api.get(`/groups/${id}`);
export const leaveGroup = (id) => api.post(`/groups/${id}/leave`);
export const updateGroupLocation = (id, data) => api.post(`/groups/${id}/location`, data);
