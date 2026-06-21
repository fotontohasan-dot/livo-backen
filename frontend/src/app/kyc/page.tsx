'use client';

import { useState } from 'react';
import axios from 'axios';

export default function KycPage() {
  const [formData, setFormData] = useState({
    fullName: '',
    dateOfBirth: '',
    nationality: '',
    address: '',
    documentType: 'nid',
    documentNumber: '',
  });

  const [files, setFiles] = useState({
    documentFront: null as File | null,
    documentBack: null as File | null,
    selfie: null as File | null,
  });

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFiles({ ...files, [e.target.name]: e.target.files[0] });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    const data = new FormData();
    Object.keys(formData).forEach(key => {
      data.append(key, formData[key as keyof typeof formData]);
    });

    if (files.documentFront) data.append('documentFront', files.documentFront);
    if (files.documentBack) data.append('documentBack', files.documentBack);
    if (files.selfie) data.append('selfie', files.selfie);

    try {
      const res = await axios.post('http://localhost:5000/api/kyc/submit', data, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setMessage(res.data.message || '✅ KYC জমা দেওয়া হয়েছে!');
    } catch (error: any) {
      setMessage('❌ সমস্যা হয়েছে: ' + (error.response?.data?.message || error.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 py-8 px-4">
      <div className="max-w-2xl mx-auto bg-zinc-900 rounded-3xl shadow-2xl border border-zinc-800 overflow-hidden">
        
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 p-8 text-center">
          <h1 className="text-4xl font-bold mb-2">KYC Verification</h1>
          <p className="text-zinc-200">আপনার অ্যাকাউন্ট সুরক্ষিত করুন</p>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          
          <div>
            <label className="block text-sm mb-2 font-medium">পুরো নাম</label>
            <input type="text" name="fullName" required
              onChange={handleInputChange}
              className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-xl focus:outline-none focus:border-purple-500" />
          </div>

          <div>
            <label className="block text-sm mb-2 font-medium">জন্ম তারিখ</label>
            <input type="date" name="dateOfBirth" required
              onChange={handleInputChange}
              className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-xl focus:outline-none focus:border-purple-500" />
          </div>

          <div>
            <label className="block text-sm mb-2 font-medium">জাতীয়তা (২ অক্ষর)</label>
            <input type="text" name="nationality" maxLength={2} required
              onChange={handleInputChange}
              className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-xl focus:outline-none focus:border-purple-500" />
          </div>

          <div>
            <label className="block text-sm mb-2 font-medium">ঠিকানা</label>
            <input type="text" name="address" required
              onChange={handleInputChange}
              className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-xl focus:outline-none focus:border-purple-500" />
          </div>

          <div>
            <label className="block text-sm mb-2 font-medium">ডকুমেন্ট টাইপ</label>
            <select name="documentType" required onChange={handleInputChange}
              className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-xl">
              <option value="nid">National ID (NID)</option>
              <option value="passport">Passport</option>
              <option value="driving_license">Driving License</option>
            </select>
          </div>

          <div>
            <label className="block text-sm mb-2 font-medium">ডকুমেন্ট নাম্বার</label>
            <input type="text" name="documentNumber" required
              onChange={handleInputChange}
              className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-xl focus:outline-none focus:border-purple-500" />
          </div>

          {/* File Uploads */}
          <div className="grid grid-cols-1 gap-6">
            <div>
              <label className="block text-sm mb-2 font-medium">ডকুমেন্ট সামনের অংশ (ছবি)</label>
              <input type="file" name="documentFront" accept="image/*" required onChange={handleFileChange}
                className="w-full text-sm text-zinc-400 file:mr-4 file:py-3 file:px-6 file:rounded-xl file:border-0 file:bg-purple-600 file:text-white" />
            </div>

            <div>
              <label className="block text-sm mb-2 font-medium">ডকুমেন্ট পিছনের অংশ (ঐচ্ছিক)</label>
              <input type="file" name="documentBack" accept="image/*" onChange={handleFileChange}
                className="w-full text-sm text-zinc-400 file:mr-4 file:py-3 file:px-6 file:rounded-xl file:border-0 file:bg-purple-600 file:text-white" />
            </div>

            <div>
              <label className="block text-sm mb-2 font-medium">সেলফি (মুখ দেখা যাবে)</label>
              <input type="file" name="selfie" accept="image/*" required onChange={handleFileChange}
                className="w-full text-sm text-zinc-400 file:mr-4 file:py-3 file:px-6 file:rounded-xl file:border-0 file:bg-purple-600 file:text-white" />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 rounded-2xl font-semibold text-lg hover:brightness-110 transition disabled:opacity-50"
          >
            {loading ? 'জমা দেওয়া হচ্ছে...' : 'KYC জমা দিন'}
          </button>

          {message && (
            <div className={`p-4 rounded-2xl text-center font-medium ${message.includes('✅') ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}`}>
              {message}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
