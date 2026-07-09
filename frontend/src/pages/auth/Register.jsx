import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Input from '../../components/UI/Input';
import Button from '../../components/UI/Button';
import toast from 'react-hot-toast';

const Register = () => {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', confirmPassword: '' });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (!form.email) errs.email = 'Email is required';
    if (!form.password || form.password.length < 6) errs.password = 'Password must be at least 6 characters';
    if (form.password !== form.confirmPassword) errs.confirmPassword = 'Passwords do not match';
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setLoading(true);
    try {
      const user = await register({ name: form.name, email: form.email, phone: form.phone, password: form.password });
      toast.success(`Welcome to CaribWayz, ${user.name}!`);
      navigate('/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    background: '#f5f5f5', border: '1px solid #ddd', borderRadius: 8,
    color: '#111', padding: '0.65rem 0.9rem', fontSize: '0.93rem', width: '100%', outline: 'none',
  };
  const labelStyle = {
    fontSize: '0.78rem', fontWeight: 700, color: '#444',
    display: 'block', marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.05em',
  };
  const Field = ({ label, error, children }) => (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
      {error && <p style={{ color: '#D12229', fontSize: '0.78rem', marginTop: '0.25rem' }}>{error}</p>}
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0A1A0A', padding: '1rem' }}>
      <div style={{ background: '#ffffff', borderRadius: 16, padding: '2.5rem', width: '100%', maxWidth: '440px', boxShadow: '0 8px 40px rgba(0,0,0,0.4)' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 800 }}>
            <span style={{ color: '#D12229' }}>Ca</span><span style={{ color: '#F5A623' }}>rib</span><span style={{ color: '#3AAA3A' }}>Wa</span><span style={{ color: '#000000' }}>yz</span>
          </h1>
          <p style={{ color: '#666', marginTop: '0.5rem', fontSize: '0.9rem' }}>Create your account</p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Field label="Full Name" error={errors.name}>
            <input name="name" placeholder="John Doe" value={form.name} onChange={handleChange} style={inputStyle} />
          </Field>
          <Field label="Email Address" error={errors.email}>
            <input type="email" name="email" placeholder="you@example.com" value={form.email} onChange={handleChange} style={inputStyle} />
          </Field>
          <Field label="Phone Number (optional)">
            <input type="tel" name="phone" placeholder="+1 868 000 0000" value={form.phone} onChange={handleChange} style={inputStyle} />
          </Field>
          <Field label="Password" error={errors.password}>
            <input type="password" name="password" placeholder="••••••••" value={form.password} onChange={handleChange} style={inputStyle} />
          </Field>
          <Field label="Confirm Password" error={errors.confirmPassword}>
            <input type="password" name="confirmPassword" placeholder="••••••••" value={form.confirmPassword} onChange={handleChange} style={inputStyle} />
          </Field>

          <button type="submit" disabled={loading} style={{
            background: '#D12229', color: '#fff', border: 'none', borderRadius: 8,
            padding: '0.75rem', fontWeight: 700, fontSize: '1rem', cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1, width: '100%', marginTop: '0.5rem',
          }}>
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.88rem', color: '#666' }}>
          Already have an account?{' '}
          <Link to="/login" style={{ color: '#D12229', fontWeight: 600 }}>Sign in</Link>
        </p>
      </div>
    </div>
  );
};

export default Register;
