'use client';
import { GameCard } from '@/components/GameCard';
import { BalanceWidget } from '@/components/BalanceWidget';
import { JackpotCounter } from '@/components/JackpotCounter';
import { QuickLinkButton } from '@/components/QuickLinkButton';
import { VIPBadge } from '@/components/VIPBadge';
import { PromotionBanner } from '@/components/PromotionBanner';
import { Bell, MessageSquare, Menu, Search, Trophy, History, Users, Clock, ShieldCheck, HeartPulse, Download, LogOut, Gift, Share2, Wallet, UserCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import Link from 'next/link';

export default function HomePage() {
  const games = [
    { name: "Aviator", emoji: "🚀", provider: "SPRIBE", badge: "HOT" as const, slug: "aviator" },
    { name: "Teen Patti", emoji: "🃏", provider: "JL", badge: "POP" as const, slug: "teen-patti" },
    { name: "Dragon Tiger", emoji: "🐉", provider: "JL", badge: "HOT" as const, slug: "dragon-tiger" },
    { name: "Fortune Gems", emoji: "💎", provider: "JDB", badge: "NEW" as const, slug: "fortune-gems" },
    { name: "Crazy Time", emoji: "🎡", provider: "EVO", badge: "HOT" as const, slug: "crazy-time" },
    { name: "Mines", emoji: "💣", provider: "SPRIBE", badge: "NEW" as const, slug: "mines" },
  ];

  return (
    <div className="min-h-screen pb-24 bg-background text-text-primary font-sans selection:bg-accent selection:text-on-accent">
      {/* 1. Top Header */}
      <header className="sticky top-0 z-50 glass border-b border-border px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Menu className="text-icon-secondary" size={24} />
          <div className="text-2xl font-black italic tracking-tighter text-accent flex items-center gap-1">
            LIVO
            <div className="w-1.5 h-1.5 bg-danger rounded-full animate-pulse mt-2" />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <BalanceWidget />
          <div className="flex items-center gap-2">
            <div className="relative">
              <Bell size={20} className="text-icon-secondary" />
              <div className="absolute -top-1 -right-1 w-2 h-2 bg-danger rounded-full border-2 border-background" />
            </div>
            <Link href="/profile">
              <div className="relative">
                <div className="w-8 h-8 rounded-full bg-accent-soft border border-accent/40 flex items-center justify-center">
                  <UserCircle size={20} className="text-accent" />
                </div>
                <div className="absolute -bottom-1 -right-1 scale-75">
                  <VIPBadge level={3} />
                </div>
              </div>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-4 space-y-6">
        {/* News Ticker */}
        <div className="glass rounded-xl p-3 flex items-center gap-3 overflow-hidden">
          <div className="bg-accent text-on-accent text-[10px] font-black px-2 py-0.5 rounded italic">HOT</div>
          <div className="flex-1 overflow-hidden">
            <motion.div
              animate={{ x: [400, -1000] }}
              transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
              className="whitespace-nowrap text-xs font-medium text-text-muted"
            >
              🎉 Welcome to LIVO! Get 50% First Deposit Bonus 💰 Invite friends and earn 3000 BDT 🤝 Mystery bonuses distributed daily! 🏆
            </motion.div>
          </div>
        </div>

        {/* 2. Hero Banner */}
        <PromotionBanner
          title="WELCOME BONUS"
          description="50% Extra on first deposit + 3000 referral bonus"
          cta="GET NOW"
        />

        {/* 3. Quick Links */}
        <section className="card-premium p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-black text-accent tracking-widest uppercase">Quick Actions</h3>
            <span className="text-[10px] text-text-muted font-bold cursor-pointer hover:text-accent transition-colors">SEE ALL →</span>
          </div>
          <div className="grid grid-cols-5 gap-2">
            <QuickLinkButton href="#" icon="⏱️" label="In-Play" color="linear-gradient(135deg,#ef4444,#dc2626)" badge="LIVE" />
            <QuickLinkButton href="#" icon="🏏" label="Cricket" color="linear-gradient(135deg,#10b981,#059669)" />
            <QuickLinkButton href="#" icon="⚽" label="Football" color="linear-gradient(135deg,#0ea5e9,#0284c7)" />
            <QuickLinkButton href="#" icon="🏆" label="WC 2026" color="linear-gradient(135deg,#f59e0b,#d97706)" badge="HOT" />
            <QuickLinkButton href="#" icon="🎯" label="Prediction" color="linear-gradient(135deg,#8b5cf6,#7c3aed)" />
          </div>
        </section>

        {/* 4. Stats Bar */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { value: "500+", label: "GAMES" },
            { value: "24/7", label: "SUPPORT" },
            { value: "6.5M", label: "PLAYERS" }
          ].map((stat, i) => (
            <div key={i} className="card-premium p-3 text-center">
              <div className="text-xl font-black italic text-accent leading-none tracking-tighter">{stat.value}</div>
              <div className="text-[8px] font-bold text-text-muted mt-1 tracking-widest">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* 5. Hot Games Section */}
        <section>
          <div className="flex items-center justify-between mb-4 px-1">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-6 bg-accent rounded-full" />
              <h3 className="text-lg font-black italic tracking-tighter uppercase">Hot Games</h3>
            </div>
            <div className="flex items-center gap-2">
              <Search size={16} className="text-icon-secondary" />
              <div className="h-4 w-[1px] bg-border" />
              <span className="text-[10px] font-black text-accent">VIEW ALL</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {games.map((game, i) => (
              <GameCard key={i} {...game} />
            ))}
          </div>
        </section>

        {/* 6. Mega Jackpot */}
        <JackpotCounter />

        {/* 7. Winners List */}
        <section className="card-premium overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h3 className="text-sm font-black italic uppercase flex items-center gap-2">
              <Trophy size={16} className="text-accent" />
              Live Winners
            </h3>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-success rounded-full animate-pulse" />
              <span className="text-[10px] font-bold text-success">LIVE UPDATING</span>
            </div>
          </div>
          <div className="divide-y divide-border">
            {[
              { user: "***882", amount: "৳15,68,523", icon: "🥇", color: "text-accent" },
              { user: "***742", amount: "৳11,44,556", icon: "🥈", color: "text-text-muted" },
              { user: "***118", amount: "৳9,98,541", icon: "🥉", color: "text-orange-400" },
            ].map((winner, i) => (
              <div key={i} className="px-4 py-3 flex items-center justify-between hover:bg-accent-soft transition-colors">
                <div className="flex items-center gap-3">
                  <span className={`text-xl ${winner.color}`}>{winner.icon}</span>
                  <div className="text-xs font-bold">{winner.user}</div>
                </div>
                <div className="text-success font-black italic tracking-tighter">{winner.amount}</div>
              </div>
            ))}
          </div>
        </section>

        {/* 8. Promotions */}
        <div className="grid grid-cols-2 gap-3">
          <div className="card-premium p-4 border-l-4 border-l-accent group cursor-pointer">
            <div className="text-[10px] font-black text-text-muted uppercase mb-1">Welcome</div>
            <div className="text-2xl font-black italic text-accent group-hover:scale-105 transition-transform origin-left tracking-tighter">100% BONUS</div>
          </div>
          <div className="card-premium p-4 border-l-4 border-l-success group cursor-pointer">
            <div className="text-[10px] font-black text-text-muted uppercase mb-1">Daily</div>
            <div className="text-2xl font-black italic text-success group-hover:scale-105 transition-transform origin-left tracking-tighter">10% CASHBACK</div>
          </div>
        </div>

        {/* Footer info */}
        <footer className="pt-8 pb-4 text-center space-y-6">
          <div className="text-3xl font-black italic tracking-tighter text-text-muted/30">LIVO</div>
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-[10px] font-bold text-text-muted uppercase tracking-widest">
            <Link href="#">Privacy</Link>
            <Link href="#">Terms</Link>
            <Link href="#">Rules</Link>
            <Link href="#">KYC</Link>
          </div>
          <div className="flex justify-center gap-4">
            <div className="glass px-3 py-1 rounded-full text-danger text-[10px] font-black">🔞 18+</div>
            <div className="glass px-3 py-1 rounded-full text-text-muted text-[10px] font-black">CURACAO LICENSED</div>
          </div>
          <p className="text-[9px] text-text-muted/60 leading-relaxed max-w-[280px] mx-auto font-medium">
            © 2024 LIVO Gaming. All Rights Reserved. Play responsibly and within your limits.
          </p>
        </footer>
      </main>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 glass border-t border-border px-4 h-20 flex items-center justify-around max-w-md mx-auto">
        <BottomNavLink icon={<Users size={20} />} label="Invite" />
        <BottomNavLink icon={<Trophy size={20} />} label="Promos" />
        <Link href="/" className="relative -mt-10 group">
          <div className="w-16 h-16 rounded-full bg-gold-gradient p-1 shadow-[0_0_20px_var(--glow-accent)] group-active:scale-95 transition-transform">
            <div className="w-full h-full rounded-full bg-background flex items-center justify-center">
              <div className="text-accent font-black italic tracking-tighter">HOME</div>
            </div>
          </div>
        </Link>
        <BottomNavLink icon={<MessageSquare size={20} />} label="Support" />
        <BottomNavLink icon={<UserCircle size={20} />} label="Member" active />
      </nav>
    </div>
  );
}

function BottomNavLink({ icon, label, active = false }: { icon: React.ReactNode, label: string, active?: boolean }) {
  return (
    <div className={`flex flex-col items-center gap-1.5 cursor-pointer transition-colors ${active ? 'text-accent' : 'text-icon-primary'}`}>
      {icon}
      <span className="text-[9px] font-black uppercase tracking-widest">{label}</span>
    </div>
  );
}
