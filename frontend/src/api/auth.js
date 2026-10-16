import api from './axios';

export const register = (data) => api.post('/auth/register', data);
export const login = (data) => api.post('/auth/login', data);
// The second step when two-step sign-in is on: { challenge, code }.
export const verifyLoginCode = (data) => api.post('/auth/login/verify-code', data);
export const forgotPassword = (email) => api.post('/auth/forgot-password', { email });
export const verifyOtp = (data) => api.post('/auth/otp-verify', data);
export const logout = () => api.post('/auth/logout');
