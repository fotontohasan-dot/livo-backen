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
          badge === 'HOT' ? 'bg-accent text-white' :
          badge === 'NEW' ? 'bg-secondary text-white' :
          'bg-primary text-black'
        }`}>
          {badge}
        </div>
      )}

      <div className="aspect-square flex items-center justify-center text-6xl bg-white/5 group-hover:bg-white/10 transition-colors">
        <span className="drop-shadow-xl">{emoji}</span>
      </div>

      <div className="p-3 bg-black/40 backdrop-blur-sm border-t border-white/5">
        <div className="text-sm font-bold truncate text-text-main">{name}</div>
        <div className="text-[10px] text-primary font-medium tracking-wider">{provider}</div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        whileHover={{ opacity: 1 }}
        className="absolute inset-0 bg-primary/20 flex items-center justify-center backdrop-blur-[2px]"
      >
        <button className="bg-primary text-black px-4 py-2 rounded-full font-bold text-sm shadow-lg shadow-primary/20">
          PLAY NOW
        </button>
      </motion.div>
    </motion.div>
  );
};
