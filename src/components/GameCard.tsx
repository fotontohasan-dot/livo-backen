import { motion } from 'framer-motion';
import Image from 'next/image';

interface GameCardProps {
  name: string;
  emoji: string;
  provider: string;
  badge?: 'HOT' | 'NEW' | 'POP';
  slug: string;
}

export const GameCard = ({ name, emoji, provider, badge, slug }: GameCardProps) => {
  return (
    <motion.div
      whileHover={{ translateY: -8, scale: 1.02 }}
      className="card-premium relative group cursor-pointer"
    >
      {badge && (
        <div className={`absolute top-2 left-2 z-10 px-2 py-0.5 rounded text-[10px] font-bold ${
          badge === 'HOT' ? 'bg-accent text-on-accent' :
          badge === 'NEW' ? 'bg-success text-white' :
          'bg-accent-soft text-accent-text'
        }`}>
          {badge}
        </div>
      )}

      <div className="aspect-square flex items-center justify-center text-6xl bg-background-secondary group-hover:bg-accent-soft transition-colors">
        <span className="drop-shadow-xl">{emoji}</span>
      </div>

      <div className="p-3 bg-surface/85 backdrop-blur-sm border-t border-border">
        <div className="text-sm font-bold truncate text-text-primary">{name}</div>
        <div className="text-[10px] text-accent-text font-medium tracking-wider">{provider}</div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        whileHover={{ opacity: 1 }}
        className="absolute inset-0 bg-accent/20 flex items-center justify-center backdrop-blur-[2px]"
      >
        <button className="bg-accent text-on-accent px-4 py-2 rounded-full font-bold text-sm shadow-lg shadow-accent/20">
          PLAY NOW
        </button>
      </motion.div>
    </motion.div>
  );
};
