import api from './axios';

export const createRoute = (data) => api.post('/routes/create', data);
export const getRoutes = () => api.get('/routes');
export const getRouteById = (id) => api.get(`/routes/${id}`);
export const updateRoute = (id, data) => api.put(`/routes/${id}`, data);
export const startNavigation = (id) => api.post(`/routes/${id}/start`);
export const completeRoute = (id) => api.post(`/routes/${id}/complete`);
