import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Input from '../../components/UI/Input';
import Button from '../../components/UI/Button';
import toast from 'react-hot-toast';

const Login = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.email) errs.email = 'Email is required';
    if (!form.password) errs.password = 'Password is required';
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setLoading(true);
    try {
      const user = await login(form.email, form.password);
      toast.success(`Welcome back, ${user.name}!`);
      navigate('/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    background: '#f5f5f5', border: '1px solid #ddd', borderRadius: 8,
    color: '#111', padding: '0.65rem 0.9rem', fontSize: '0.93rem', width: '100%',
    outline: 'none',
  };
  const labelStyle = {
    fontSize: '0.78rem', fontWeight: 700, color: '#444',
    display: 'block', marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.05em',
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '1rem' }}>
      <div style={{ background: '#ffffff', borderRadius: 16, padding: '2.5rem', width: '100%', maxWidth: '420px', boxShadow: '0 8px 40px rgba(0,0,0,0.4)' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.85rem' }}>
            <img src="/logo.jpg" alt="CaribWayz" style={{ width: 72, height: 72, objectFit: 'contain', borderRadius: 16 }} />
          </div>
          <h1 style={{ fontSize: '2rem', fontWeight: 800 }}>
            <span style={{ color: '#D12229' }}>Ca</span><span style={{ color: '#F5A623' }}>rib</span><span style={{ color: '#3AAA3A' }}>Wa</span><span style={{ color: '#000000' }}>yz</span>
          </h1>
          <p style={{ color: '#666', marginTop: '0.5rem', fontSize: '0.9rem' }}>Sign in to your account</p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
          <div>
            <label style={labelStyle}>Email Address</label>
            <input type="email" name="email" placeholder="you@example.com" value={form.email} onChange={handleChange} style={inputStyle} />
            {errors.email && <p style={{ color: '#D12229', fontSize: '0.78rem', marginTop: '0.25rem' }}>{errors.email}</p>}
          </div>
          <div>
            <label style={labelStyle}>Password</label>
            <input type="password" name="password" placeholder="••••••••" value={form.password} onChange={handleChange} style={inputStyle} />
            {errors.password && <p style={{ color: '#D12229', fontSize: '0.78rem', marginTop: '0.25rem' }}>{errors.password}</p>}
          </div>

          <div style={{ textAlign: 'right' }}>
            <Link to="/forgot-password" style={{ fontSize: '0.85rem', color: '#D12229', fontWeight: 600 }}>
              Forgot password?
            </Link>
          </div>

          <button type="submit" disabled={loading} style={{
            background: '#D12229', color: '#fff', border: 'none', borderRadius: 8,
            padding: '0.75rem', fontWeight: 700, fontSize: '1rem', cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1, width: '100%',
          }}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.88rem', color: '#666' }}>
          Don't have an account?{' '}
          <Link to="/register" style={{ color: '#D12229', fontWeight: 600 }}>Sign up</Link>
        </p>
      </div>
    </div>
  );
};

export default Login;
