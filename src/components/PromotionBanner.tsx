import { motion } from 'framer-motion';
import { Trophy } from 'lucide-react';

interface PromotionBannerProps {
  title: string;
  description: string;
  cta: string;
  image?: string;
  className?: string;
}

export const PromotionBanner = ({ title, description, cta, image, className }: PromotionBannerProps) => {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-accent/20 p-6 flex items-center ${className}`}
      style={{ backgroundImage: 'var(--hero-bg)' }}
    >
      <div className="z-10 relative flex-1">
        <h2 className="text-3xl font-black text-accent italic leading-tight tracking-tighter uppercase">
          {title}
        </h2>
        <p className="text-text-secondary text-sm mt-1 font-medium max-w-[200px]">
          {description}
        </p>
        <button className="mt-4 bg-accent text-on-accent px-6 py-2 rounded-full font-black text-sm hover:brightness-110 transition-all uppercase">
          {cta}
        </button>
      </div>

      <div className="absolute right-0 top-1/2 -translate-y-1/2 opacity-20 pointer-events-none">
        <Trophy size={140} className="text-accent" />
      </div>

      {/* Decorative particles/glow */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-accent/20 blur-[50px] -mr-10 -mt-10" />
    </div>
  );
};
