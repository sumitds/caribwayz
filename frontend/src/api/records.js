import api from './axios';

export const getMyRecords = (params) => api.get('/records', { params });
export const getRecordById = (id) => api.get(`/records/${id}`);
export const createRecord = (data) => api.post('/records', data);
export const deleteRecord = (id) => api.delete(`/records/${id}`);
