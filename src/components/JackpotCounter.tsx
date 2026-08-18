'use client';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export const JackpotCounter = () => {
  const [value, setValue] = useState(88617517);

  useEffect(() => {
    const interval = setInterval(() => {
      setValue(prev => prev + Math.floor(Math.random() * 500 + 100));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="card-premium p-6 text-center border-2 border-accent/30 relative overflow-hidden">
      {/* Decorative Glows */}
      <div className="absolute -top-10 -left-10 w-32 h-32 bg-accent/20 blur-[60px]" />
      <div className="absolute -bottom-10 -right-10 w-32 h-32 bg-accent/20 blur-[60px]" />

      <div className="text-accent text-xs font-black tracking-[0.3em] uppercase mb-4 flex items-center justify-center gap-2">
        <span className="w-8 h-[1px] bg-accent/50" />
        Mega Jackpot
        <span className="w-8 h-[1px] bg-accent/50" />
      </div>

      <div className="flex items-center justify-center gap-2">
        <span className="text-accent text-3xl font-bold self-start mt-2">৳</span>
        <div className="text-accent text-6xl font-black tracking-tighter drop-shadow-[0_0_15px_var(--glow-accent)]">
          {value.toLocaleString('en-US')}
        </div>
      </div>

      <p className="text-text-muted text-[10px] mt-4 font-medium">LUCKY DRAW EVERY HOUR • PLAY NOW TO WIN</p>

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className="mt-6 btn-gold w-full max-w-[200px] shadow-[0_0_20px_var(--glow-accent)]"
      >
        PLAY JACKPOT 🎰
      </motion.button>
    </div>
  );
};
