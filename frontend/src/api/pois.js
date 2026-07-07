import api from './axios';

export const getPois = (params) => api.get('/pois', { params });
