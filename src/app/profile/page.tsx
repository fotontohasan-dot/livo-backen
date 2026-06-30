'use client';
import { VIPBadge } from '@/components/VIPBadge';
import { IconGrid } from '@/components/IconGrid';
import {
  Settings, Bell, ShieldCheck, History, Users,
  HelpCircle, Download, LogOut, Wallet,
  ChevronRight, CreditCard, Gift, PieChart,
  MessageSquare, HeartPulse, Mail
} from 'lucide-react';
import Link from 'next/link';

export default function ProfilePage() {
  const memberActions = [
    { icon: <Users size={24} />, label: "Invite Friends" },
    { icon: <History size={24} />, label: "Bet Record" },
    { icon: <PieChart size={24} />, label: "Profit & Loss" },
    { icon: <History size={24} />, label: "Transaction" },
    { icon: <ShieldCheck size={24} />, label: "Security Center" },
    { icon: <HeartPulse size={24} />, label: "Responsible Gaming" },
    { icon: <Mail size={24} />, label: "Mail", badge: 2 },
    { icon: <MessageSquare size={24} />, label: "Feedback" },
    { icon: <Download size={24} />, label: "App Download" },
    { icon: <HelpCircle size={24} />, label: "Support" },
    { icon: <LogOut size={24} />, label: "Logout" },
  ];

  return (
    <div className="min-h-screen pb-24 bg-background text-text-main">
      {/* Header */}
      <header className="p-4 flex items-center justify-between border-b border-white/5 bg-background/50 backdrop-blur-md sticky top-0 z-50">
        <h1 className="text-xl font-black italic tracking-tighter uppercase">Member Center</h1>
        <div className="flex items-center gap-3">
          <Link href="/settings"><Settings size={22} className="text-text-muted" /></Link>
          <div className="relative">
            <Bell size={22} className="text-text-muted" />
            <div className="absolute top-0 right-0 w-2 h-2 bg-accent rounded-full border-2 border-background" />
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto p-4 space-y-6">
        {/* User Info Card */}
        <section className="card-premium p-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 blur-3xl -mr-16 -mt-16" />

          <div className="flex items-center gap-4 relative z-10">
            <div className="w-16 h-16 rounded-full border-2 border-primary/50 p-1 bg-background shadow-[0_0_15px_rgba(251,191,36,0.3)]">
              <div className="w-full h-full rounded-full bg-gradient-to-br from-primary/40 to-primary/10 flex items-center justify-center text-2xl font-black italic text-primary">
                LH
              </div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-black italic tracking-tighter">tuhinhasan73</h2>
                <VIPBadge level={3} />
              </div>
              <p className="text-[10px] text-text-muted font-bold tracking-widest mt-0.5">MEMBER SINCE 2023</p>

              <div className="mt-3 space-y-1.5">
                <div className="flex justify-between text-[9px] font-black uppercase tracking-tighter">
                  <span className="text-primary">VIP 3 Progress</span>
                  <span className="text-text-muted">75%</span>
                </div>
                <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden border border-white/5">
                  <div className="h-full bg-gold-gradient w-[75%] rounded-full shadow-[0_0_10px_rgba(251,191,36,0.5)]" />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Balance & Quick Finance */}
        <section className="grid grid-cols-1 gap-3">
          <div className="card-premium p-5 bg-gradient-to-br from-[#1e293b] to-[#0f172a] border-primary/20">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-[10px] font-black text-text-muted tracking-widest uppercase">Total Balance</p>
                <h3 className="text-4xl font-black italic text-primary tracking-tighter mt-1">৳1,568,523.00</h3>
              </div>
              <div className="bg-primary/20 p-2 rounded-xl border border-primary/30">
                <Wallet className="text-primary" size={24} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 mt-6">
              <FinanceBtn icon={<Wallet size={18} />} label="Deposit" primary />
              <FinanceBtn icon={<CreditCard size={18} />} label="Withdraw" />
              <FinanceBtn icon={<History size={18} />} label="Records" />
            </div>
          </div>
        </section>

        {/* Bonus & Rewards Grid */}
        <section>
          <h3 className="text-xs font-black text-primary tracking-widest uppercase mb-4 px-1 flex items-center gap-2">
            <Gift size={14} />
            Bonuses & Rewards
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <RewardCard title="Daily Reward" sub="Check-in & Earn" icon="🎁" />
            <RewardCard title="Cashback" sub="Weekly Return" icon="💰" color="text-secondary" />
            <RewardCard title="Lucky Wheel" sub="Spin to Win" icon="🎡" />
            <RewardCard title="VIP Mission" sub="Exclusive Tasks" icon="🏆" />
          </div>
        </section>

        {/* Member Center Links */}
        <section className="card-premium p-2">
          <IconGrid items={memberActions} columns={4} />
        </section>

        {/* Support Banner */}
        <div className="card-premium p-4 bg-primary/5 border-primary/20 flex items-center justify-between group cursor-pointer hover:bg-primary/10 transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary">
              <MessageSquare size={20} />
            </div>
            <div>
              <p className="text-xs font-black italic tracking-tighter uppercase">24/7 Live Support</p>
              <p className="text-[10px] text-text-muted font-medium">We are here to help you</p>
            </div>
          </div>
          <ChevronRight size={18} className="text-text-muted group-hover:text-primary transition-colors" />
        </div>
      </main>
    </div>
  );
}

function FinanceBtn({ icon, label, primary = false }: { icon: React.ReactNode, label: string, primary?: boolean }) {
  return (
    <button className={`flex flex-col items-center gap-2 py-3 rounded-xl transition-all active:scale-95 border ${
      primary
        ? 'bg-gold-gradient text-black border-transparent shadow-[0_5px_15px_rgba(251,191,36,0.3)]'
        : 'bg-white/5 text-text-main border-white/10 hover:bg-white/10'
    }`}>
      {icon}
      <span className="text-[10px] font-black uppercase tracking-tighter">{label}</span>
    </button>
  );
}

function RewardCard({ title, sub, icon, color = "text-primary" }: { title: string, sub: string, icon: string, color?: string }) {
  return (
    <div className="card-premium p-4 flex items-center gap-3 hover:border-primary/30 transition-colors cursor-pointer group">
      <div className="text-2xl group-hover:scale-110 transition-transform">{icon}</div>
      <div>
        <h4 className="text-[11px] font-black italic uppercase tracking-tighter leading-none">{title}</h4>
        <p className={`text-[9px] font-bold ${color} mt-1 leading-none`}>{sub}</p>
      </div>
    </div>
  );
}
