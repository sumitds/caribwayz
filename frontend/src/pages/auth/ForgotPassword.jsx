import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { forgotPassword, verifyOtp } from '../../api/auth';
import Input from '../../components/UI/Input';
import Button from '../../components/UI/Button';
import toast from 'react-hot-toast';

const ForgotPassword = () => {
  const [step, setStep] = useState(1); // 1=email, 2=otp+new password
  const [form, setForm] = useState({ email: '', otp: '', new_password: '', confirmPassword: '' });
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSendOtp = async (e) => {
    e.preventDefault();
    if (!form.email) return toast.error('Email is required');
    setLoading(true);
    try {
      await forgotPassword(form.email);
      toast.success('OTP sent! Check your email/phone.');
      setStep(2);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    if (form.new_password !== form.confirmPassword) return toast.error('Passwords do not match');
    setLoading(true);
    try {
      await verifyOtp({ email: form.email, otp: form.otp, new_password: form.new_password });
      toast.success('Password reset successfully! Please log in.');
      setStep(1);
    } catch (err) {
      toast.error(err.response?.data?.message || 'OTP verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '1rem' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '2.5rem', width: '100%', maxWidth: '420px' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.5rem' }}>Reset Password</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
          {step === 1 ? 'Enter your email to receive an OTP' : 'Enter the OTP and your new password'}
        </p>

        {step === 1 ? (
          <form onSubmit={handleSendOtp} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Input label="Email Address" type="email" name="email" placeholder="you@example.com" value={form.email} onChange={handleChange} />
            <Button type="submit" fullWidth loading={loading}>Send OTP</Button>
          </form>
        ) : (
          <form onSubmit={handleReset} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Input label="OTP Code" name="otp" placeholder="6-digit code" maxLength={6} value={form.otp} onChange={handleChange} />
            <Input label="New Password" type="password" name="new_password" placeholder="••••••••" value={form.new_password} onChange={handleChange} />
            <Input label="Confirm Password" type="password" name="confirmPassword" placeholder="••••••••" value={form.confirmPassword} onChange={handleChange} />
            <Button type="submit" fullWidth loading={loading}>Reset Password</Button>
            <Button variant="ghost" fullWidth onClick={() => setStep(1)}>Back</Button>
          </form>
        )}

        <p style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.88rem', color: 'var(--text-muted)' }}>
          <Link to="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>Back to Login</Link>
        </p>
      </div>
    </div>
  );
};

export default ForgotPassword;
