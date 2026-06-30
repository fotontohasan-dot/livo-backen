import { Crown } from 'lucide-react';

export const VIPBadge = ({ level = 1 }: { level?: number }) => {
  return (
    <div className="flex items-center gap-1 bg-gold-gradient px-2 py-0.5 rounded-full border border-white/20 shadow-lg">
      <Crown size={10} className="text-black fill-black" />
      <span className="text-[10px] font-black text-black leading-none">VIP {level}</span>
    </div>
  );
};
