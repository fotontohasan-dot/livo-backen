'use client';
import { VIPBadge } from '@/components/VIPBadge';
import { IconGrid } from '@/components/IconGrid';
import {
  Settings, Bell, ShieldCheck, History, Users,
  HelpCircle, Download, LogOut, Wallet,
  ChevronRight, CreditCard, Gift, PieChart,
  MessageSquare, HeartPulse, Mail, Crown, Trophy
} from 'lucide-react';

export default function ProfilePage() {
  // Account & Support quick links (no duplicates: Transaction/Records live under
  // the Wallet hub, Invite Friends & Missions live under Reward/VIP hubs)
  const accountActions = [
    { icon: <History size={24} />, label: "Bet Record", href: "/profile/history" },
    { icon: <PieChart size={24} />, label: "Profit & Loss", href: "/profile/stats" },
    { icon: <ShieldCheck size={24} />, label: "Security Center", href: "/profile/security" },
    { icon: <HeartPulse size={24} />, label: "Responsible Gaming", href: "/profile/responsible" },
    { icon: <Mail size={24} />, label: "Mail", badge: 2, href: "/profile/chat" },
    { icon: <MessageSquare size={24} />, label: "Feedback", href: "/profile/feedback" },
    { icon: <Download size={24} />, label: "App Download", href: "/profile/app-download" },
    { icon: <HelpCircle size={24} />, label: "Support", href: "/profile/support" },
    { icon: <LogOut size={24} />, label: "Logout", href: "/logout" },
  ];

  return (
    <div className="min-h-screen pb-24 bg-background text-text-main overflow-x-hidden">
      {/* Header */}
      <header className="p-4 sm:p-5 lg:px-8 flex items-center justify-between border-b border-white/5 bg-background/50 backdrop-blur-md sticky top-0 z-50">
        <h1 className="text-lg sm:text-xl lg:text-2xl font-black italic tracking-tighter uppercase">Member Center</h1>
        <div className="flex items-center gap-3 sm:gap-4">
          <a href="/profile/security" className="shrink-0">
            <Settings size={22} className="text-text-muted" />
          </a>
          {/* Single Notification Bell */}
          <a href="/notifications" className="relative shrink-0">
            <Bell size={22} className="text-text-muted" />
            <div className="absolute top-0 right-0 w-2 h-2 bg-accent rounded-full border-2 border-background" />
          </a>
        </div>
      </header>

      <main className="max-w-md sm:max-w-2xl lg:max-w-5xl xl:max-w-6xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6 lg:space-y-8">
        {/* User Info Card */}
        <a href="/profile" className="card-premium p-5 sm:p-6 relative overflow-hidden block hover:border-primary/30 transition-colors">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 blur-3xl -mr-16 -mt-16" />

          <div className="flex items-center gap-4 relative z-10 min-w-0">
            <div className="w-14 h-14 sm:w-16 sm:h-16 shrink-0 rounded-full border-2 border-primary/50 p-1 bg-background shadow-[0_0_15px_rgba(251,191,36,0.3)]">
              <div className="w-full h-full rounded-full bg-gradient-to-br from-primary/40 to-primary/10 flex items-center justify-center text-xl sm:text-2xl font-black italic text-primary">
                LH
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base sm:text-lg font-black italic tracking-tighter truncate">tuhinhasan73</h2>
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
        </a>

        {/* Main Hubs: Wallet, VIP Center, Reward Center */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
          {/* Wallet Hub */}
          <section className="card-premium p-5 sm:p-6 bg-gradient-to-br from-[#1e293b] to-[#0f172a] border-primary/20 flex flex-col">
            <div className="flex justify-between items-start gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-black text-text-muted tracking-widest uppercase">Wallet</p>
                <h3 className="text-2xl sm:text-3xl font-black italic text-primary tracking-tighter mt-1 truncate">
                  ৳1,568,523.00
                </h3>
              </div>
              <div className="bg-primary/20 p-2 rounded-xl border border-primary/30 shrink-0">
                <Wallet className="text-primary" size={22} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 sm:gap-3 mt-6">
              <FinanceBtn icon={<Wallet size={18} />} label="Deposit" href="/payment/deposit" primary />
              <FinanceBtn icon={<CreditCard size={18} />} label="Withdraw" href="/payment/withdraw" />
              <FinanceBtn icon={<History size={18} />} label="Records" href="/profile/transactions" />
            </div>
          </section>

          {/* VIP Center Hub */}
          <section className="card-premium p-5 sm:p-6 flex flex-col">
            <div className="flex justify-between items-start gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-black text-text-muted tracking-widest uppercase">VIP Center</p>
                <h3 className="text-2xl sm:text-3xl font-black italic text-primary tracking-tighter mt-1">Level 3</h3>
              </div>
              <div className="bg-primary/20 p-2 rounded-xl border border-primary/30 shrink-0">
                <Crown className="text-primary" size={22} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 sm:gap-3 mt-6">
              <FinanceBtn icon={<Trophy size={18} />} label="Missions" href="/profile/missions" />
              <FinanceBtn icon={<Gift size={18} />} label="Benefits" href="/profile/vip" />
              <FinanceBtn icon={<History size={18} />} label="History" href="/profile/vip" />
            </div>
          </section>

          {/* Reward Center Hub */}
          <section className="card-premium p-5 sm:p-6 flex flex-col">
            <div className="flex justify-between items-start gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-black text-text-muted tracking-widest uppercase">Reward Center</p>
                <h3 className="text-2xl sm:text-3xl font-black italic text-primary tracking-tighter mt-1">3 Ready</h3>
              </div>
              <div className="bg-primary/20 p-2 rounded-xl border border-primary/30 shrink-0">
                <Gift className="text-primary" size={22} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 sm:gap-3 mt-6">
              <FinanceBtn icon={<span className="text-base leading-none">🎁</span>} label="Daily" href="/profile/rewards" primary />
              <FinanceBtn icon={<span className="text-base leading-none">🎡</span>} label="Wheel" href="/profile/wheel" />
              <FinanceBtn icon={<Users size={18} />} label="Invite" href="/profile/referral" />
            </div>
          </section>
        </div>

        {/* Account & Support Links */}
        <section>
          <h3 className="text-xs sm:text-sm font-black text-primary tracking-widest uppercase mb-4 px-1 flex items-center gap-2">
            <ShieldCheck size={14} />
            Account &amp; Support
          </h3>
          <div className="card-premium p-2 sm:p-4">
            <IconGrid items={accountActions} columns={4} />
          </div>
        </section>

        {/* Support Banner */}
        <a href="/profile/chat" className="card-premium p-4 sm:p-5 bg-primary/5 border-primary/20 flex items-center justify-between gap-3 group cursor-pointer hover:bg-primary/10 transition-colors">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-full bg-primary/20 flex items-center justify-center text-primary">
              <MessageSquare size={20} />
            </div>
            <div className="min-w-0">
              <p className="text-xs sm:text-sm font-black italic tracking-tighter uppercase truncate">24/7 Live Support</p>
              <p className="text-[10px] sm:text-xs text-text-muted font-medium truncate">We are here to help you</p>
            </div>
          </div>
          <ChevronRight size={18} className="text-text-muted group-hover:text-primary transition-colors shrink-0" />
        </a>
      </main>
    </div>
  );
}

function FinanceBtn({ icon, label, href, primary = false }: { icon: React.ReactNode, label: string, href: string, primary?: boolean }) {
  return (
    <a href={href} className={`flex flex-col items-center gap-2 py-2.5 sm:py-3 rounded-xl transition-all active:scale-95 border w-full ${
      primary
        ? 'bg-gold-gradient text-black border-transparent shadow-[0_5px_15px_rgba(251,191,36,0.3)]'
        : 'bg-white/5 text-text-main border-white/10 hover:bg-white/10'
    }`}>
      {icon}
      <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-tighter">{label}</span>
    </a>
  );
}
