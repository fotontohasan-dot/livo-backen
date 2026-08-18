'use client';

// =============================================
// রেজিস্ট্রেশন পেজ — এখানে পুরো ফর্ম রাখবেন
// =============================================

import { useState } from 'react';
import { Eye, EyeOff, Check, X } from 'lucide-react';

export default function RegisterPage() {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    referralCode: '',
  });

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: '' }));
    }
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (formData.password.length < 8) {
      newErrors.password = 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষর হতে হবে';
    }

    if (!formData.confirmPassword) {
      newErrors.confirmPassword = 'কনফার্ম পাসওয়ার্ড দিতে হবে';
    } else if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'পাসওয়ার্ড মিলছে না';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;

    setLoading(true);
    // TODO: Backend API call এখানে করবেন
    console.log('Registration Data:', formData);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-background text-text-primary flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Username */}
          <div>
            <label className="block text-sm mb-2 text-text-secondary">ইউজারনেম</label>
            <input
              type="text"
              name="username"
              value={formData.username}
              onChange={handleChange}
              className="w-full bg-surface-elevated border border-border rounded-lg px-4 py-3 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="কয় খান"
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-sm mb-2 text-text-secondary">ইমেইল</label>
            <div className="flex gap-3">
              <input
                type="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                className="flex-1 bg-surface-elevated border border-border rounded-lg px-4 py-3 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="tuhinhasan732144@gmail.com"
              />
              <button
                type="button"
                className="bg-accent text-on-accent hover:brightness-110 px-6 rounded-lg font-medium whitespace-nowrap transition-all"
              >
                OTP পাঠান
              </button>
            </div>
          </div>

          {/* Password with Show/Hide */}
          <div>
            <label className="block text-sm mb-2 text-text-secondary">পাসওয়ার্ড</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={formData.password}
                onChange={handleChange}
                className="w-full bg-surface-elevated border border-border rounded-lg px-4 py-3 pr-12 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-icon-secondary hover:text-text-primary"
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {errors.password && <p className="text-danger text-sm mt-1">{errors.password}</p>}
          </div>

          {/* Confirm Password with Show/Hide */}
          <div>
            <label className="block text-sm mb-2 text-text-secondary">কনফার্ম পাসওয়ার্ড</label>
            <div className="relative">
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                name="confirmPassword"
                value={formData.confirmPassword}
                onChange={handleChange}
                className="w-full bg-surface-elevated border border-border rounded-lg px-4 py-3 pr-12 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-icon-secondary hover:text-text-primary"
              >
                {showConfirmPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {errors.confirmPassword && (
              <p className="text-danger text-sm mt-1">{errors.confirmPassword}</p>
            )}
            {formData.confirmPassword && formData.password === formData.confirmPassword && (
              <p className="text-success text-sm mt-1 flex items-center gap-1">
                <Check size={16} /> পাসওয়ার্ড মিলেছে
              </p>
            )}
          </div>

          {/* Referral Code */}
          <div>
            <label className="block text-sm mb-2 text-text-secondary">রেফারেল কোড (ঐচ্ছিক)</label>
            <input
              type="text"
              name="referralCode"
              value={formData.referralCode}
              onChange={handleChange}
              className="w-full bg-surface-elevated border border-border rounded-lg px-4 py-3 text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="রেফারেল কোড থাকলে দিন"
            />
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading}
            className="w-full btn-gold py-4 flex items-center justify-center gap-2 disabled:opacity-70"
          >
            ✅ রেজিস্ট্রেশন করুন
          </button>
        </form>
      </div>
    </div>
  );
}
