import api from './axios';

export const createGroup = (data) => api.post('/groups', data);
export const joinGroup = (join_code, current_latitude, current_longitude) =>
  api.post('/groups/join', { join_code, current_latitude, current_longitude });
export const getGroupDetails = (id) => api.get(`/groups/${id}`);
export const leaveGroup = (id) => api.post(`/groups/${id}/leave`);
export const updateGroupLocation = (id, data) => api.post(`/groups/${id}/location`, data);
export const inviteToGroup = (id, emails) => api.post(`/groups/${id}/invite`, { email: emails });
export const getGroupsByUser = (userId) => api.get(`/groups/user/${userId}`);
