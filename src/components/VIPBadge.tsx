import { Crown } from 'lucide-react';

export const VIPBadge = ({ level = 1 }: { level?: number }) => {
  return (
    <div className="flex items-center gap-1 bg-gold-gradient px-2 py-0.5 rounded-full border border-on-accent/10 shadow-sm">
      <Crown size={10} className="text-on-accent fill-on-accent" />
      <span className="text-[10px] font-black text-on-accent leading-none">VIP {level}</span>
    </div>
  );
};
