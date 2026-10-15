import React, { createContext, useContext, useState, useEffect } from 'react';
import { login as apiLogin, verifyLoginCode as apiVerifyLoginCode, register as apiRegister, logout as apiLogout } from '../api/auth';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storedToken = localStorage.getItem('cw_token');
    const storedUser = localStorage.getItem('cw_user');
    if (storedToken && storedUser) {
      setToken(storedToken);
      setUser(JSON.parse(storedUser));
    }
    setLoading(false);
  }, []);

  const saveSession = ({ user, token }) => {
    if (typeof token !== 'string' || token === '' || !user) {
      throw new Error('The sign-in answer had no session');
    }
    localStorage.setItem('cw_token', token);
    localStorage.setItem('cw_user', JSON.stringify(user));
    setToken(token);
    setUser(user);
    return user;
  };

  // Rejects with the API's 403 TWO_FACTOR_REQUIRED when two-step sign-in is
  // on; the page then asks for the emailed code (see loginModel.js).
  const login = async (email, password) => {
    const res = await apiLogin({ email, password });
    return saveSession(res.data.data);
  };

  const completeTwoFactorLogin = async (challenge, code) => {
    const res = await apiVerifyLoginCode({ challenge, code });
    return saveSession(res.data.data);
  };

  const register = async (data) => {
    const res = await apiRegister(data);
    const { user, token } = res.data.data;
    localStorage.setItem('cw_token', token);
    localStorage.setItem('cw_user', JSON.stringify(user));
    setToken(token);
    setUser(user);
    return user;
  };

  const logout = async () => {
    try { await apiLogout(); } catch (_) {}
    localStorage.removeItem('cw_token');
    localStorage.removeItem('cw_user');
    setToken(null);
    setUser(null);
  };

  const updateUser = (updatedUser) => {
    setUser(updatedUser);
    localStorage.setItem('cw_user', JSON.stringify(updatedUser));
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, completeTwoFactorLogin, register, logout, updateUser, isAdmin: user?.role === 'admin' }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
